#!/usr/bin/env ruby
require "open3"
require "tempfile"
require "timeout"

root = File.expand_path("..", __dir__)
source = File.read(File.join(root, "lib", "goal-checkin.js"))
start = source.index("export async function deliverGoalCheckIn")
abort "Could not extract goal delivery" unless start
delivery = source[start..].sub("export async function", "async function")
active_start = source.index("export function isGoalPlaybackActive")
active_finish = source.index("function unionSeconds", active_start || 0)
abort "Could not extract goal activity helper" unless active_start && active_finish
activity = source[active_start...active_finish].sub("export function", "function")

fixture = <<~JAVASCRIPT
  const GOAL_CHECKIN_MESSAGE = "Hope you’re clear on your goal for watching this video.";
  function playbackStreamKey(event) { return `${event.tabID}:${event.frameID}:${event.playerID}:${event.sessionID}`; }
  #{activity}
  #{delivery}
  function assertDelivery(value, message) { if (!value) throw new Error(message); }
  const event = { eventID: "goal-event", sessionID: "goal-session", playerID: "goal-player", tabID: 7, frameID: 2, occurredAtMs: 1_000, state: "heartbeat", isVisible: true, isTabActive: true };
  function mockBrowser({ toastFails = false, notificationFails = false, onToast = null } = {}) {
    const calls = [];
    return {
      calls,
      tabs: { async sendMessage(tabID, message, options) {
        calls.push({ kind: "tab", tabID, message, options });
        if (message.type === "SHOW_TOAST" && toastFails) throw new Error("toast unavailable");
        if (message.type === "SHOW_TOAST") onToast?.();
        return { ok: true };
      } },
      notifications: {
        async create(id, options) { calls.push({ kind: "notification", id, options }); if (notificationFails) throw new Error("notifications unavailable"); },
        async clear(id) { calls.push({ kind: "clear", id }); return true; }
      },
      runtime: { getURL(path) { return `chrome-extension://watchwise/${path}`; } }
    };
  }

  const normal = mockBrowser();
  assertDelivery(await deliverGoalCheckIn({ browser: normal, event, isAllowed: async () => true }), "normal delivery did not succeed");
  const toast = normal.calls.filter((call) => call.kind === "tab" && call.message.type === "SHOW_TOAST");
  const notice = normal.calls.filter((call) => call.kind === "notification");
  assertDelivery(toast.length === 1 && notice.length === 1, "normal delivery was not exactly one toast and one notification");
  assertDelivery(toast[0].message.text === GOAL_CHECKIN_MESSAGE && Object.keys(toast[0].message).length === 2, "toast body was not the exact goal message");
  assertDelivery(notice[0].options.message === GOAL_CHECKIN_MESSAGE, "notification body was not the exact goal message");

  const suppressed = mockBrowser();
  assertDelivery(!(await deliverGoalCheckIn({ browser: suppressed, event, isAllowed: async () => false })), "suppressed delivery reported success");
  assertDelivery(suppressed.calls.length === 0, "suppressed delivery touched Chrome APIs");

  const afterToast = mockBrowser();
  const toastAllowance = [true, false];
  assertDelivery(!(await deliverGoalCheckIn({ browser: afterToast, event, isAllowed: async () => toastAllowance.shift() ?? false })), "privacy change after toast reported success");
  assertDelivery(afterToast.calls.some((call) => call.message?.type === "HIDE_TOAST"), "privacy change after toast did not hide it");
  assertDelivery(!afterToast.calls.some((call) => call.kind === "notification"), "privacy change after toast still created a notification");

  let playback = [event];
  const pausedBrowser = mockBrowser({ onToast() { playback.push({ ...event, eventID: "paused", occurredAtMs: 2_000, state: "paused" }); } });
  assertDelivery(!(await deliverGoalCheckIn({ browser: pausedBrowser, event, isAllowed: async () => isGoalPlaybackActive(playback, event, 2_000) })), "pause after reservation reported delivery success");
  assertDelivery(pausedBrowser.calls.some((call) => call.message?.type === "HIDE_TOAST") && !pausedBrowser.calls.some((call) => call.kind === "notification"), "pause after toast was not hidden before notification");

  playback = [event];
  const hiddenBrowser = mockBrowser({ onToast() { playback.push({ ...event, eventID: "hidden", occurredAtMs: 2_000, state: "heartbeat", isVisible: false }); } });
  assertDelivery(!(await deliverGoalCheckIn({ browser: hiddenBrowser, event, isAllowed: async () => isGoalPlaybackActive(playback, event, 2_000) })), "hidden playback after reservation reported delivery success");
  assertDelivery(hiddenBrowser.calls.some((call) => call.message?.type === "HIDE_TOAST") && !hiddenBrowser.calls.some((call) => call.kind === "notification"), "hidden playback did not block notification and hide toast");

  const afterNotification = mockBrowser();
  const notificationAllowance = [true, true, false];
  assertDelivery(!(await deliverGoalCheckIn({ browser: afterNotification, event, isAllowed: async () => notificationAllowance.shift() ?? false })), "privacy change after notification reported success");
  assertDelivery(afterNotification.calls.some((call) => call.kind === "clear"), "privacy change after notification did not clear it");
  assertDelivery(afterNotification.calls.some((call) => call.message?.type === "HIDE_TOAST"), "privacy change after notification did not hide the toast");

  const failed = mockBrowser({ toastFails: true, notificationFails: true });
  assertDelivery(!(await deliverGoalCheckIn({ browser: failed, event, isAllowed: async () => true })), "failed APIs reported delivery success");
  assertDelivery(failed.calls.filter((call) => call.message?.type === "SHOW_TOAST").length === 1, "failed toast was retried");
  assertDelivery(failed.calls.filter((call) => call.kind === "notification").length === 1, "failed notification was retried");
  print("Goal check-in delivery orchestration: PASS");
JAVASCRIPT

file = Tempfile.new(["watchwise-goal-delivery", ".mjs"])
file.write(fixture)
file.flush
stdout = stderr = status = nil
begin
  Open3.popen3("/System/Library/Frameworks/JavaScriptCore.framework/Versions/A/Helpers/jsc", "-m", file.path) do |stdin, out, err, wait|
    stdin.close
    out_thread = Thread.new { out.read }
    err_thread = Thread.new { err.read }
    begin
      Timeout.timeout(10) { status = wait.value }
    rescue Timeout::Error
      Process.kill("TERM", wait.pid) rescue nil
      raise "Goal delivery JSC test timed out"
    ensure
      stdout = out_thread.value
      stderr = err_thread.value
    end
  end
ensure
  file.close!
end
abort [stdout, stderr].join("\n") unless status&.success?
abort "Goal delivery test did not report PASS" unless stdout.include?("Goal check-in delivery orchestration: PASS")
puts "Goal check-in delivery orchestration: PASS"
