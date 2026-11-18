#!/usr/bin/env ruby
require "json"
require "open3"
require "tmpdir"

unless ARGV.length == 1
  warn "Usage: test-bridge.rb /absolute/path/to/WatchwiseBridge"
  exit 64
end
bridge = ARGV[0]
abort "Bridge must be executable" unless bridge.start_with?("/") && File.executable?(bridge)
abort "/usr/bin/sqlite3 is required for row-count verification" unless File.executable?("/usr/bin/sqlite3")

def frame(object)
  payload = JSON.generate(object)
  [payload.bytesize].pack("L<") + payload
end

def read_frame(io)
  header = io.read(4)
  raise "Missing response header" unless header&.bytesize == 4
  length = header.unpack1("L<")
  payload = io.read(length)
  raise "Truncated response" unless payload&.bytesize == length
  JSON.parse(payload)
end

def playback_row_count(database)
  output, error, status = Open3.capture3(
    "/usr/bin/sqlite3",
    database,
    "SELECT COUNT(*) FROM playback_events;"
  )
  raise "sqlite3 count failed: #{error.strip}" unless status.success?
  Integer(output.strip, 10)
end

def distinct_session_count(database)
  output, error, status = Open3.capture3(
    "/usr/bin/sqlite3",
    database,
    "SELECT COUNT(DISTINCT session_id) FROM playback_events;"
  )
  raise "sqlite3 session count failed: #{error.strip}" unless status.success?
  Integer(output.strip, 10)
end

Dir.mktmpdir("watchwise-bridge-test") do |directory|
  database = File.join(directory, "history.sqlite3")
  settings = File.join(directory, "bridge-settings.json")
  File.write(settings, JSON.generate(schemaVersion: 1, trackingConsent: true, excludedSites: []))
  stdin, stdout, stderr, wait = Open3.popen3(bridge, "--database-path", database)
  event = {
    schemaVersion: 1,
    title: "Bridge contract test",
    url: "https://www.youtube.com/watch?v=contract-test",
    site: "www.youtube.com",
    pageSite: "video.example.com",
    duration: 600.0,
    position: 10.0,
    playbackRate: 1.0,
    state: "playing",
    occurredAtMilliseconds: (Time.now.to_f * 1000).round,
    documentVisible: true,
    playerID: "5A5232D2-A235-4B0A-8D39-1E58E9A470A1"
  }
  stdin.write(frame(event))
  response = read_frame(stdout)
  raise "Bridge rejected valid contract event" unless response == { "ok" => true }
  event[:position] = 25.0
  event[:state] = "heartbeat"
  event[:occurredAtMilliseconds] += 15_000
  stdin.write(frame(event))
  second_response = read_frame(stdout)
  raise "Persistent bridge rejected second framed event" unless second_response == { "ok" => true }
  stdin.close
  raise "Bridge wrote diagnostic payload data" unless stderr.read.empty?
  raise "Bridge failed" unless wait.value.success?
  raise "Bridge did not create its SQLite database" unless File.exist?(database)
  raise "Persistent bridge did not append both accepted events" unless playback_row_count(database) == 2
  raise "Stable player ID did not retain one session" unless distinct_session_count(database) == 1

  # A parent-domain exclusion must reject the validated subdomain event.
  File.write(settings, JSON.generate(schemaVersion: 1, trackingConsent: true, excludedSites: ["example.com"]))
  stdin, stdout, stderr, wait = Open3.popen3(bridge, "--database-path", database)
  stdin.write(frame(event))
  stdin.close
  response = read_frame(stdout)
  raise "Bridge ignored native-app site exclusion" unless response == { "error" => "privacy_blocked", "ok" => false }
  raise "Bridge wrote diagnostic payload data" unless stderr.read.empty?
  raise "Bridge failed while applying exclusion" unless wait.value.success?
  raise "Top-level-site exclusion changed playback history" unless playback_row_count(database) == 2

  # Corrupt or missing consent state must fail closed.
  File.write(settings, "not-json")
  stdin, stdout, stderr, wait = Open3.popen3(bridge, "--database-path", database)
  stdin.write(frame(event))
  stdin.close
  response = read_frame(stdout)
  raise "Bridge accepted corrupt privacy settings" unless response["ok"] == false
  raise "Bridge wrote diagnostic payload data" unless stderr.read.empty?
  raise "Bridge failed while rejecting corrupt settings" unless wait.value.success?
  raise "Corrupt-consent event changed playback history" unless playback_row_count(database) == 2
end

puts "Native messaging framing, decoder, consent/exclusions, and SQLite append: PASS"
