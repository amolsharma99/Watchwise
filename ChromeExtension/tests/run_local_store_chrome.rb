#!/usr/bin/env ruby
require "open3"
require "socket"
require "tempfile"
require "tmpdir"
require "timeout"

root = File.expand_path("..", __dir__)
packager = File.join(root, "scripts", "package_local_store.rb")
chrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
abort "Google Chrome is unavailable" unless File.executable?(chrome)

Dir.mktmpdir("watchwise-local-chrome") do |workspace|
  stage = File.join(workspace, "production")
  stdout, stderr, status = Open3.capture3("ruby", packager, "--stage", stage)
  abort [stdout, stderr].join("\n") unless status.success?

  html = <<~HTML
    <!doctype html><meta charset="utf-8"><body id="result">PENDING</body>
    <script type="module">
      import {
        IndexedDBRepository, DATABASE_NAME, RECORD_STORE, KEY_STORE, decryptEnvelope,
        insertPlaybackEvent, playbackEventRange
      } from "./lib/storage.js";
      const result = document.querySelector("#result");
      const check = (value, message) => { if (!value) throw new Error(message); };
      const request = (value) => new Promise((resolve, reject) => { value.onsuccess = () => resolve(value.result); value.onerror = () => reject(value.error); });
      const transactionDone = (value) => new Promise((resolve, reject) => { value.oncomplete = resolve; value.onerror = () => reject(value.error); value.onabort = () => reject(value.error); });
      const rejected = async (operation, message) => { try { await operation(); } catch { return; } throw new Error(message); };
      const rawDatabase = async () => request(indexedDB.open(DATABASE_NAME, 1));
      const rawRecords = async (database) => { const tx = database.transaction(RECORD_STORE, "readonly"); const done = transactionDone(tx); const values = await request(tx.objectStore(RECORD_STORE).getAll()); await done; return values; };
      const rawKeys = async (database) => { const tx = database.transaction(KEY_STORE, "readonly"); const done = transactionDone(tx); const values = await request(tx.objectStore(KEY_STORE).getAll()); await done; return values; };
      const event = (id, occurredAtMs, title = "Sensitive Watch Title") => ({
        schemaVersion: 1, eventID: id, sessionID: `session-${id}`, playerID: `player-${id}`,
        tabID: 1, frameID: 0, frameSite: "video.example", pageSite: "video.example",
        url: "https://video.example/watch", mediaTitle: title, durationSeconds: 120,
        positionSeconds: 20, playbackRate: 1, state: "playing", occurredAtMs,
        isVisible: true, isTabActive: true
      });

      try {
        await new Promise((resolve) => { const deletion = indexedDB.deleteDatabase(DATABASE_NAME); deletion.onsuccess = deletion.onerror = deletion.onblocked = resolve; });
        const now = Date.now();
        const repositoryA = new IndexedDBRepository();
        const repositoryB = new IndexedDBRepository();
        const state = {
          schemaVersion: 1,
          settings: { trackingEnabled: true, notificationsEnabled: true, excludedSites: ["private.example"], dailyLimitSeconds: 1800 },
          onboardingComplete: true,
          nudgeState: { emittedAtMs: [now - 1000] },
          goalCheckInState: { processed: [{ identity: "youtube:secret-video" }] }
        };
        await Promise.all([repositoryA.setState(state), repositoryB.putEvent(event("event-one", now - 5000))]);

        const repositoryC = new IndexedDBRepository();
        const reopenedState = await repositoryC.getState();
        const reopenedEvents = await repositoryC.listEvents();
        check(reopenedState.settings.excludedSites[0] === "private.example" && reopenedState.onboardingComplete, "encrypted state did not survive reopen");
        check(reopenedEvents.length === 1 && reopenedEvents[0].mediaTitle === "Sensitive Watch Title", "encrypted event did not survive reopen");

        const database = await rawDatabase();
        let records = await rawRecords(database);
        const keys = await rawKeys(database);
        check(keys.length === 1, "concurrent first open did not converge on one key");
        const key = keys[0].key;
        check(key.extractable === false && key.algorithm.name === "AES-GCM" && key.algorithm.length === 256, "key policy is incorrect");
        check(key.usages.length === 2 && key.usages.includes("encrypt") && key.usages.includes("decrypt"), "key usages are incorrect");
        await rejected(() => crypto.subtle.exportKey("raw", key), "non-extractable key was exported");
        check(new Set(records.map((record) => record.iv)).size === records.length, "IVs are not unique");
        const rawText = JSON.stringify(records);
        for (const secret of ["Sensitive Watch Title", "https://video.example/watch", "video.example", "private.example", "secret-video", String(now - 5000), "trackingEnabled"]) check(!rawText.includes(secret), `plaintext leaked: ${secret}`);
        check(records.every((record) => Object.keys(record).sort().join(",") === "ciphertext,iv,recordID,recordType,schemaVersion"), "clear record fields exceed the envelope contract");

        const eventEnvelope = records.find((record) => record.recordType === "e");
        const alteredCiphertext = `${eventEnvelope.ciphertext[0] === "A" ? "B" : "A"}${eventEnvelope.ciphertext.slice(1)}`;
        await rejected(() => decryptEnvelope({ ...eventEnvelope, ciphertext: alteredCiphertext }, key), "tampered ciphertext authenticated");
        await rejected(() => decryptEnvelope({ ...eventEnvelope, recordType: "s" }, key), "tampered AAD authenticated");
        await rejected(() => decryptEnvelope({ ...eventEnvelope, recordID: "11111111-1111-4111-8111-111111111111" }, key), "tampered record ID authenticated");
        await rejected(() => decryptEnvelope({ ...eventEnvelope, schemaVersion: 2 }, key), "tampered schema version authenticated");

        const helperStarted = performance.now();
        const ordered = [];
        for (let index = 0; index < 100_000; index += 1) insertPlaybackEvent(ordered, { occurredAtMs: index * 10, eventID: `ordered-${String(index).padStart(6, "0")}` });
        insertPlaybackEvent(ordered, { occurredAtMs: 500_005, eventID: "out-of-order" });
        insertPlaybackEvent(ordered, { occurredAtMs: 1_000_000, eventID: "append" });
        const helperRange = playbackEventRange(ordered, 500_000, 500_020);
        check(ordered.length === 100_002 && ordered.at(-1).eventID === "append", "large sorted append failed");
        check(helperRange.map((item) => item.eventID).join(",") === "ordered-050000,out-of-order,ordered-050001", "large binary range or out-of-order insert failed");
        const helperMs = Math.round(performance.now() - helperStarted);

        await repositoryA.putEvent(event("event-old", now - 100000));
        await repositoryA.putEvent(event("event-new", now - 1000, "Newest Title"));
        await repositoryA.prune(now - 10000);
        const afterPrune = await repositoryA.listEvents();
        check(afterPrune.length === 2 && afterPrune.some((item) => item.eventID === "event-new"), "prune lost survivors or kept expired event");

        await repositoryC.listEvents();
        await repositoryB.putEvent(event("event-late", now, "Late Cross Context"));
        const exported = await repositoryC.exportData(reopenedState.settings);
        check(exported.playbackEvents.some((item) => item.eventID === "event-late"), "fresh export missed another context's write");
        check(exported.settings.excludedSites[0] === "private.example", "explicit export lost safe settings");

        records = await rawRecords(database);
        const corruptible = records.find((record) => record.recordType === "e");
        const corruptTx = database.transaction(RECORD_STORE, "readwrite");
        const corruptDone = transactionDone(corruptTx);
        corruptTx.objectStore(RECORD_STORE).put({ ...corruptible, ciphertext: "corrupt" });
        await corruptDone;
        await rejected(() => new IndexedDBRepository().listEvents(), "repository accepted tampered history");
        await repositoryC.deleteAll();
        check((await rawRecords(database)).every((record) => record.recordType === "s"), "delete did not remove corrupt event records");
        check((await repositoryC.getState()).settings.excludedSites[0] === "private.example", "event delete removed encrypted settings");
        await repositoryC.setState({ ...(await repositoryC.getState()), maintenance: { lastPruneAtMs: now } });
        const restartedState = await new IndexedDBRepository().getState();
        check(restartedState.maintenance.lastPruneAtMs === now, "maintenance cadence did not survive restart");

        const performanceRepository = new IndexedDBRepository();
        const writeStarted = performance.now();
        for (let offset = 0; offset < 2000; offset += 25) {
          const batch = [];
          for (let index = offset; index < offset + 25; index += 1) {
            const timestamp = index < 1000 ? now - 200 * 24 * 60 * 60 * 1000 - index : now - 24 * 60 * 60 * 1000 + index;
            batch.push(performanceRepository.putEvent(event(`perf-${index}`, timestamp, `Performance ${index}`)));
          }
          await Promise.all(batch);
        }
        const writeMs = Math.round(performance.now() - writeStarted);
        const reopenedPerformance = new IndexedDBRepository();
        const reopenStarted = performance.now();
        check((await reopenedPerformance.listEvents(now - 7 * 24 * 60 * 60 * 1000, now + 1)).length === 1000, "current-week encrypted query count is wrong");
        const reopenMs = Math.round(performance.now() - reopenStarted);
        const pruneStarted = performance.now();
        await reopenedPerformance.prune(now - 180 * 24 * 60 * 60 * 1000);
        check((await reopenedPerformance.listEvents()).length === 1000, "bulk encrypted prune count is wrong");
        const pruneMs = Math.round(performance.now() - pruneStarted);

        const missingKeyTx = database.transaction(KEY_STORE, "readwrite");
        const missingKeyDone = transactionDone(missingKeyTx);
        missingKeyTx.objectStore(KEY_STORE).clear();
        await missingKeyDone;
        const recoveryRepository = new IndexedDBRepository();
        await rejected(() => recoveryRepository.getState(), "missing key beside ciphertext did not fail closed");
        const resetState = await recoveryRepository.resetSecureStorage();
        check(resetState.onboardingComplete === false && resetState.settings.trackingEnabled !== true, "secure reset did not restore consent-off defaults");
        records = await rawRecords(database);
        const resetKeys = await rawKeys(database);
        check(records.length === 1 && records[0].recordType === "s", "secure reset retained encrypted history");
        check(resetKeys.length === 1 && resetKeys[0].key.extractable === false && resetKeys[0].key.algorithm.length === 256, "secure reset did not create a non-extractable AES-256 key");

        const corruptStateTx = database.transaction(RECORD_STORE, "readwrite");
        const corruptStateDone = transactionDone(corruptStateTx);
        const stateEnvelope = records[0];
        corruptStateTx.objectStore(RECORD_STORE).put({ ...stateEnvelope, ciphertext: "corrupt" });
        await corruptStateDone;
        const corruptStateRepository = new IndexedDBRepository();
        await rejected(() => corruptStateRepository.getState(), "corrupt encrypted state did not fail closed");
        await corruptStateRepository.resetSecureStorage();
        check((await corruptStateRepository.getState()).onboardingComplete === false, "corrupt-state recovery did not return to onboarding");
        database.close();
        location.href = `/pass?helper100k=${helperMs}&write=${writeMs}&reopen=${reopenMs}&prune=${pruneMs}`;
      } catch (error) {
        location.href = `/fail?message=${encodeURIComponent(error?.stack || error)}`;
      }
    </script>
  HTML
  File.write(File.join(stage, "crypto-test.html"), html)
  server = TCPServer.new("127.0.0.1", 0)
  port = server.addr[1]
  completion = Queue.new
  server_thread = Thread.new do
    loop do
      socket = nil
      begin
        socket = server.accept
        request_line = socket.gets
        next unless request_line
        request_parts = request_line.split(" ")
        next unless request_parts.length >= 2 && request_parts[0] == "GET"
        raw_target = request_parts[1]
        path = raw_target.split("?", 2).first
        next unless path&.start_with?("/")
        while (header = socket.gets)
          break if header == "\r\n" || header == "\n"
        end
        relative = path.sub(%r{\A/}, "")
        target = File.expand_path(relative, stage)
        if path == "/pass" || path == "/fail"
          completion << raw_target
          body = "done"
          socket.write "HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: #{body.bytesize}\r\nConnection: close\r\n\r\n#{body}"
        elsif target.start_with?("#{stage}/") && File.file?(target)
          body = File.binread(target)
          type = target.end_with?(".js") ? "text/javascript" : "text/html"
          socket.write "HTTP/1.1 200 OK\r\nContent-Type: #{type}\r\nContent-Length: #{body.bytesize}\r\nConnection: close\r\n\r\n"
          socket.write body
        else
          socket.write "HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
        end
      rescue Errno::EPIPE, Errno::ECONNRESET
        # Browser probes may disconnect before reading a response.
      ensure
        socket&.close
      end
    end
  rescue IOError, Errno::EBADF
  end
  profile = File.join(workspace, "profile")
  url = "http://127.0.0.1:#{port}/crypto-test.html"
  command = [chrome, "--headless=new", "--no-first-run", "--disable-gpu", "--user-data-dir=#{profile}", "--remote-debugging-port=0", url]
  output = error = nil
  result = nil
  completion_target = nil
  timed_out = false
  begin
    Open3.popen3(*command) do |stdin, out, err, wait|
      stdin.close
      out_thread = Thread.new { out.read }
      err_thread = Thread.new { err.read }
      begin
        Timeout.timeout(90) { completion_target = completion.pop }
      rescue Timeout::Error
        timed_out = true
      ensure
        Process.kill("TERM", wait.pid) rescue nil
        begin
          Timeout.timeout(5) { result = wait.value }
        rescue Timeout::Error
          Process.kill("KILL", wait.pid) rescue nil
          result = wait.value rescue nil
        end
        output = out_thread.value
        error = err_thread.value
      end
    end
  ensure
    server.close rescue nil
    server_thread.join(2)
  end
  abort ["Local Store headless Chrome test timed out", output, error].compact.join("\n") if timed_out
  abort [completion_target, output, error].compact.join("\n") unless completion_target&.start_with?("/pass?")
  puts "LOCAL_CRYPTO_PASS #{completion_target.split('?', 2).last.tr('&', ' ')}"
end

puts "Local Store real WebCrypto/IndexedDB contract: PASS"
