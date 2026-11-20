#!/usr/bin/env ruby
require "open3"
require "tempfile"

root = File.expand_path("..", __dir__)
%w[background.js store-local/background.js].each do |filename|
  source = File.read(File.join(root, filename))
  frame_context = source[/function frameContext\(sender\) \{.*?\n\}/m] or abort "missing frame context in #{filename}"
  exclusion = source[/async function clearInterventionsForSite\(site\) \{.*?(?=\nfunction deliverDashboardUpdate)/m] or abort "missing work exclusion in #{filename}"
  abort "work action is not routed in #{filename}" unless source.include?('if (message.action?.type === "exclude_current_site") return excludeCurrentSiteFromToast(sender);')

  fixture = <<~JAVASCRIPT
    class URL {
      constructor(value) {
        const match = /^(https?):\\/\\/([^/?#]+)/.exec(String(value));
        if (!match) throw new TypeError("invalid URL");
        this.protocol = `${match[1]}:`;
        this.hostname = match[2].toLowerCase();
      }
    }
    const chrome = {
      runtime: { id: "watchwise-test" },
      tabs: {
        async query() { return [
          { id: 10, url: "https://app.company.example/video" },
          { id: 11, url: "https://app.company.example/other" },
          { id: 13, url: "https://sub.app.company.example/video" },
          { id: 12, url: "https://other.example/video" }
        ]; },
        async sendMessage(id, message) { hidden.push({ id, message }); }
      }
    };
    const SETTINGS_KEY = "watchwiseSettings";
    let settingsRevision = 0;
    let settings = { trackingEnabled: true, notificationsEnabled: true, dailyLimitSeconds: 3600, excludedSites: ["prior.example"], aiEnabled: true };
    let mutationQueue = Promise.resolve();
    let broadcasts = 0, dashboards = 0;
    const hidden = [];
    function check(value, message) { if (!value) throw new Error(message); }
    function normalizeHostname(site) {
      if (typeof site !== "string" || !/^[a-z0-9.-]+$/.test(site) || !site.includes(".")) throw new TypeError("invalid hostname");
      return site.toLowerCase();
    }
    function isExcludedSite(site, current) { return current.excludedSites.some((excluded) => site === excluded || site.endsWith(`.${excluded}`)); }
    function normalizeSettings(value) { return { ...value, excludedSites: [...new Set(value.excludedSites)].sort() }; }
    function withDataMutation(operation) { const result = mutationQueue.then(operation, operation); mutationQueue = result.catch(() => {}); return result; }
    async function getSettings() { return settings; }
    async function localSet(values) { settings = values[SETTINGS_KEY]; }
    async function broadcastTrackingState() { broadcasts += 1; }
    async function announceDashboardUpdated() { dashboards += 1; }
    #{frame_context}
    #{exclusion}
    const sender = { id: "watchwise-test", frameId: 2, url: "https://player.cdn.example/embed", tab: { id: 10, url: "https://app.company.example/video", active: true, windowId: 1 } };
    const [first, second] = await Promise.all([excludeCurrentSiteFromToast(sender), excludeCurrentSiteFromToast(sender)]);
    check(first.site === "app.company.example" && second.site === first.site, "iframe click excluded the frame instead of the website");
    check(settings.excludedSites.join(",") === "app.company.example,prior.example", "exclusion was lost or duplicated");
    check(settings.trackingEnabled && settings.notificationsEnabled && settings.aiEnabled && settings.dailyLimitSeconds === 3600, "unrelated settings changed");
    check(settingsRevision === 1, "concurrent clicks were not idempotent");
    check(hidden.length === 6 && hidden.every(({ id, message }) => [10, 11, 13].includes(id) && message.type === "HIDE_TOAST"), "selected website toasts were missed or unrelated toasts hidden");
    check(broadcasts === 2 && dashboards === 2, "tracking/dashboard state was not refreshed");
    let rejected = false;
    try { await excludeCurrentSiteFromToast({ ...sender, id: "another-extension" }); } catch { rejected = true; }
    check(rejected && settingsRevision === 1, "foreign sender changed exclusions");
    rejected = false;
    try { await excludeCurrentSiteFromToast({ ...sender, tab: { ...sender.tab, url: "http://app.company.example/video" } }); } catch { rejected = true; }
    check(rejected && settingsRevision === 1, "non-HTTPS page changed exclusions");
    print("Work exclusion sender/atomicity contract: PASS");
  JAVASCRIPT

  Tempfile.create(["watchwise-work-exclusion", ".mjs"]) do |file|
    file.write(fixture)
    file.flush
    output, error, result = Open3.capture3("/System/Library/Frameworks/JavaScriptCore.framework/Versions/A/Helpers/jsc", "-m", file.path)
    abort [output, error].join("\n") unless result.success? && output.include?("Work exclusion sender/atomicity contract: PASS")
  end
  puts "Work exclusion sender/atomicity contract: PASS (#{filename})"
end
