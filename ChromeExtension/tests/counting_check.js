(() => {
  const BASE_COUNTING = 1_800_000_000_000;
  function assertCounting(value, message) { if (!value) throw new Error(message); }
  function countingEvent(overrides = {}) {
    return validatePlaybackEvent({
      schemaVersion: 1,
      eventID: "event-1",
      sessionID: "session-1",
      playerID: "player-1",
      tabID: 1,
      frameID: 0,
      frameSite: "www.youtube.com",
      pageSite: "www.youtube.com",
      url: "https://www.youtube.com/",
      mediaTitle: "YouTube",
      durationSeconds: 600,
      positionSeconds: 0,
      playbackRate: 1,
      state: "playing",
      occurredAtMs: BASE_COUNTING,
      isVisible: true,
      isTabActive: true,
      ...overrides
    });
  }
  const window = { startMs: BASE_COUNTING, endMs: BASE_COUNTING + 120_000 };
  const workEvent = countingEvent({ eventID: "work-active", sessionID: "work-session", playerID: "work-player", frameSite: "work.example", pageSite: "work.example", url: "https://work.example/video", mediaTitle: "Work video" });
  const liveBeforeExclusion = summarizeViewing([workEvent], window, { nowMs: BASE_COUNTING + 10_000 });
  const liveAfterExclusion = summarizeViewing([workEvent], window, { nowMs: BASE_COUNTING + 10_000, allowLiveTail: (event) => event.pageSite !== "work.example" });
  assertCounting(liveBeforeExclusion.activeSeconds === 10 && liveAfterExclusion.activeSeconds === 0, "excluded work site kept accruing optimistic viewing time");
  const youtubeForms = [
    "https://www.youtube.com/watch?v=abc",
    "https://www.youtube.com/embed/abc",
    "https://www.youtube.com/shorts/abc",
    "https://www.youtube.com/live/abc",
    "https://youtu.be/abc"
  ];
  assertCounting(youtubeForms.every((url) => youtubeVideoIdentity(url)?.videoKey === "youtube:abc"), "Supported YouTube URL forms do not share identity");

  const previewStates = ["paused", "seeking", "ended"];
  const previews = Array.from({ length: 17 }, (_, index) => countingEvent({
    eventID: `preview-${index}`, sessionID: `preview-session-${index}`,
    playerID: `preview-player-${index}`, occurredAtMs: BASE_COUNTING + index,
    state: previewStates[index % previewStates.length]
  }));
  assertCounting(summarizeViewing(previews, window).videosStarted === 0, "paused previews were counted");

  const watched = [];
  for (let index = 0; index < 3; index += 1) {
    const start = BASE_COUNTING + index * 20_000;
    watched.push(countingEvent({ eventID: `w${index}a`, sessionID: `w${index}`, playerID: `p${index}`, url: "https://www.youtube.com/watch?v=watched", occurredAtMs: start }));
    watched.push(countingEvent({ eventID: `w${index}b`, sessionID: `w${index}`, playerID: `p${index}`, url: "https://www.youtube.com/watch?v=watched", occurredAtMs: start + 5_000, positionSeconds: 5, state: "paused" }));
  }
  assertCounting(summarizeViewing(watched, window).videosStarted === 3, "meaningful sessions were not counted accurately");

  const replacement = [];
  for (let index = 0; index < youtubeForms.length; index += 1) {
    const start = BASE_COUNTING + index * 6_000;
    const host = /^https:\/\/([^/]+)/.exec(youtubeForms[index])[1];
    replacement.push(countingEvent({ eventID: `r${index}a`, sessionID: `r${index}`, playerID: `p${index}`, url: youtubeForms[index], frameSite: host, pageSite: host, occurredAtMs: start, positionSeconds: 10 + index * 5 }));
    replacement.push(countingEvent({ eventID: `r${index}b`, sessionID: `r${index}`, playerID: `p${index}`, url: youtubeForms[index], frameSite: host, pageSite: host, occurredAtMs: start + 5_000, positionSeconds: 15 + index * 5, state: "paused" }));
  }
  assertCounting(summarizeViewing(replacement, window).videosStarted === 1, "Same YouTube ID across URL forms/player rotations was double-counted");

  // A freshly reset history contains only these events. YouTube Shorts may
  // expose the current item through several overlapping DOM players.
  const shortDuplicates = [];
  for (let index = 0; index < 4; index += 1) {
    const start = BASE_COUNTING + index * 100;
    shortDuplicates.push(countingEvent({ eventID: `sd${index}a`, sessionID: `sd${index}`, playerID: `sdp${index}`, frameID: index, url: "https://www.youtube.com/shorts/short-one", occurredAtMs: start }));
    shortDuplicates.push(countingEvent({ eventID: `sd${index}b`, sessionID: `sd${index}`, playerID: `sdp${index}`, frameID: index, url: "https://www.youtube.com/shorts/short-one", occurredAtMs: start + 5_000, positionSeconds: 5, state: "paused" }));
  }
  const shortInsight = summarizeViewing(shortDuplicates, window);
  assertCounting(shortInsight.videosStarted === 1, "Overlapping players for one Short were counted as separate starts");
  assertCounting(shortInsight.videos.length === 1 && shortInsight.videos[0].activeSeconds > 0, "Short breakdown row was lost");
  assertCounting(!(shortInsight.videosStarted > 0) || shortInsight.videos.length > 0, "A counted Short start has no breakdown row");
  assertCounting(shortInsight.videos[0].url === "https://www.youtube.com/watch?v=short-one", "Short breakdown URL was not canonicalized");

  const nearZeroShortReplacement = [
    countingEvent({ eventID: "sz1", sessionID: "sza", playerID: "szpa", url: "https://www.youtube.com/shorts/short-zero", occurredAtMs: BASE_COUNTING, positionSeconds: 0 }),
    countingEvent({ eventID: "sz2", sessionID: "sza", playerID: "szpa", url: "https://www.youtube.com/shorts/short-zero", occurredAtMs: BASE_COUNTING + 5_000, positionSeconds: 5, state: "paused" }),
    countingEvent({ eventID: "sz3", sessionID: "szb", playerID: "szpb", url: "https://www.youtube.com/shorts/short-zero", occurredAtMs: BASE_COUNTING + 6_000, positionSeconds: 0 }),
    countingEvent({ eventID: "sz4", sessionID: "szb", playerID: "szpb", url: "https://www.youtube.com/shorts/short-zero", occurredAtMs: BASE_COUNTING + 11_000, positionSeconds: 5, state: "paused" })
  ];
  assertCounting(summarizeViewing(nearZeroShortReplacement, window).videosStarted === 1, "Near-zero Short replacement was counted twice");

  const laterShortReplay = nearZeroShortReplacement.concat([
    countingEvent({ eventID: "sz5", sessionID: "szc", playerID: "szpc", url: "https://www.youtube.com/shorts/short-zero", occurredAtMs: BASE_COUNTING + 20_000, positionSeconds: 0 }),
    countingEvent({ eventID: "sz6", sessionID: "szc", playerID: "szpc", url: "https://www.youtube.com/shorts/short-zero", occurredAtMs: BASE_COUNTING + 25_000, positionSeconds: 5, state: "paused" })
  ]);
  assertCounting(summarizeViewing(laterShortReplay, window).videosStarted === 2, "A later deliberate Short replay was incorrectly merged");

  const homepageThenShort = [];
  for (let index = 0; index < 3; index += 1) {
    const start = BASE_COUNTING + index * 6_000;
    homepageThenShort.push(countingEvent({ eventID: `hp${index}a`, sessionID: `hp${index}`, playerID: `hpp${index}`, url: "https://www.youtube.com/", occurredAtMs: start }));
    homepageThenShort.push(countingEvent({ eventID: `hp${index}b`, sessionID: `hp${index}`, playerID: `hpp${index}`, url: "https://www.youtube.com/", occurredAtMs: start + 5_000, positionSeconds: 5, state: "paused" }));
  }
  homepageThenShort.push(countingEvent({ eventID: "hp-short-a", sessionID: "hp-short", playerID: "hp-short-player", url: "https://www.youtube.com/shorts/real-short", occurredAtMs: BASE_COUNTING + 20_000 }));
  homepageThenShort.push(countingEvent({ eventID: "hp-short-b", sessionID: "hp-short", playerID: "hp-short-player", url: "https://www.youtube.com/shorts/real-short", occurredAtMs: BASE_COUNTING + 25_000, positionSeconds: 5, state: "paused" }));
  const homepageInsight = summarizeViewing(homepageThenShort, window);
  assertCounting(homepageInsight.videosStarted === 1, "YouTube homepage previews were counted as video starts");
  assertCounting(homepageInsight.activeSeconds === 5 && homepageInsight.contentSeconds === 5, "YouTube homepage previews leaked into time insights");
  assertCounting(homepageInsight.videos.length === 1 && homepageInsight.videos[0].url === "https://www.youtube.com/watch?v=real-short", "Exact homepage-to-Short breakdown is incorrect");

  const feed = [
    countingEvent({ eventID: "f1", sessionID: "fa", playerID: "pa", url: "https://feed.example/", frameSite: "feed.example", pageSite: "feed.example" }),
    countingEvent({ eventID: "f2", sessionID: "fa", playerID: "pa", url: "https://feed.example/", frameSite: "feed.example", pageSite: "feed.example", occurredAtMs: BASE_COUNTING + 5_000, positionSeconds: 5, state: "paused" }),
    countingEvent({ eventID: "f3", sessionID: "fb", playerID: "pb", url: "https://feed.example/", frameSite: "feed.example", pageSite: "feed.example", occurredAtMs: BASE_COUNTING + 6_000 }),
    countingEvent({ eventID: "f4", sessionID: "fb", playerID: "pb", url: "https://feed.example/", frameSite: "feed.example", pageSite: "feed.example", occurredAtMs: BASE_COUNTING + 11_000, positionSeconds: 5, state: "paused" })
  ];
  assertCounting(summarizeViewing(feed, window).videosStarted === 2, "distinct feed videos were merged");

  const lifecycleEvents = [];
  for (let index = 0; index < 6; index += 1) {
    const start = BASE_COUNTING + index * 41_000;
    const shared = { sessionID: `existing-${index}`, playerID: "reused-youtube-player", url: `https://www.youtube.com/watch?v=existing-${index}`, mediaTitle: `Existing ${index}` };
    lifecycleEvents.push(countingEvent({ ...shared, eventID: `existing-${index}-start`, occurredAtMs: start, positionSeconds: 0 }));
    lifecycleEvents.push(countingEvent({ ...shared, eventID: `existing-${index}-end`, occurredAtMs: start + 40_000, positionSeconds: 40, state: "paused" }));
  }
  [
    "https://www.youtube.com/watch?v=recent-watch-a",
    "https://www.youtube.com/shorts/recent-short-b",
    "https://www.youtube.com/watch?v=recent-watch-c",
    "https://www.youtube.com/shorts/recent-short-d"
  ].forEach((url, index) => {
    const start = BASE_COUNTING + 250_000 + index * 11_000;
    const shared = { sessionID: `recent-${index}`, playerID: "reused-youtube-player", url, mediaTitle: `Recent ${index}` };
    lifecycleEvents.push(countingEvent({ ...shared, eventID: `recent-${index}-start`, occurredAtMs: start, positionSeconds: 0 }));
    lifecycleEvents.push(countingEvent({ ...shared, eventID: `recent-${index}-end`, occurredAtMs: start + 10_000, positionSeconds: 10, state: "paused" }));
  });
  const lifecycleInsight = summarizeViewing(lifecycleEvents, { startMs: BASE_COUNTING, endMs: BASE_COUNTING + 310_000 });
  assertCounting(lifecycleInsight.videosStarted === 10, "Recovered SPA videos did not advance the existing six-start total");
  assertCounting(lifecycleInsight.activeSeconds === 280, "Recovered SPA videos did not advance the existing four-minute total");
  assertCounting(lifecycleInsight.videos.length === 10, "Recovered SPA videos are missing breakdown rows");

  const youtubeBreakdown = [
    countingEvent({ eventID: "y1", sessionID: "ya", playerID: "ya", mediaTitle: "YouTube", url: "https://www.youtube.com/watch?v=abc&utm_source=x" }),
    countingEvent({ eventID: "y2", sessionID: "ya", playerID: "ya", mediaTitle: "YouTube", url: "https://www.youtube.com/watch?v=abc", occurredAtMs: BASE_COUNTING + 6_000, positionSeconds: 6, state: "paused" }),
    countingEvent({ eventID: "y3", sessionID: "yb", playerID: "yb", mediaTitle: "Main lesson", url: "https://www.youtube.com/watch?v=abc", occurredAtMs: BASE_COUNTING + 7_000, positionSeconds: 6 }),
    countingEvent({ eventID: "y4", sessionID: "yb", playerID: "yb", mediaTitle: "Main lesson", url: "https://www.youtube.com/watch?v=abc", occurredAtMs: BASE_COUNTING + 11_000, positionSeconds: 10, state: "paused" }),
    countingEvent({ eventID: "z1", sessionID: "z", playerID: "z", mediaTitle: "Short", url: "https://www.youtube.com/watch?v=other", occurredAtMs: BASE_COUNTING, positionSeconds: 0 }),
    countingEvent({ eventID: "z2", sessionID: "z", playerID: "z", mediaTitle: "Short", url: "https://www.youtube.com/watch?v=other", occurredAtMs: BASE_COUNTING + 4_000, positionSeconds: 4, state: "paused" })
  ];
  const breakdown = summarizeViewing(youtubeBreakdown, window).videos;
  assertCounting(breakdown.length === 2, "YouTube player rotations were not grouped by canonical identity");
  assertCounting(breakdown[0].title === "Main lesson", "Breakdown title was not sanitized");
  assertCounting(breakdown[0].url === "https://www.youtube.com/watch?v=abc", "Breakdown link was not canonicalized");
  assertCounting(breakdown[0].site === "www.youtube.com", "Breakdown site missing");
  assertCounting(breakdown[0].activeSeconds === 8 && breakdown[0].activeSeconds > breakdown[1].activeSeconds, "Breakdown time/sorting is incorrect");
  const dayBreakdown = summarizeViewing(youtubeBreakdown, dayWindow(BASE_COUNTING, 0)).videos;
  const weekBreakdown = summarizeViewing(youtubeBreakdown, weekWindow(BASE_COUNTING, 0)).videos;
  assertCounting(dayBreakdown[0].title === "Main lesson" && dayBreakdown[0].url === "https://www.youtube.com/watch?v=abc", "Daily breakdown lost title/link grouping");
  assertCounting(weekBreakdown[0].title === "Main lesson" && weekBreakdown[0].url === "https://www.youtube.com/watch?v=abc", "Weekly breakdown lost title/link grouping");

  const overlapBreakdown = [
    countingEvent({ eventID: "o1", sessionID: "oa", playerID: "oa", url: "https://feed.example/", frameSite: "feed.example", pageSite: "feed.example" }),
    countingEvent({ eventID: "o2", sessionID: "oa", playerID: "oa", url: "https://feed.example/", frameSite: "feed.example", pageSite: "feed.example", occurredAtMs: BASE_COUNTING + 10_000, positionSeconds: 10, state: "paused" }),
    countingEvent({ eventID: "o3", sessionID: "ob", playerID: "ob", url: "https://feed.example/", frameSite: "feed.example", pageSite: "feed.example" }),
    countingEvent({ eventID: "o4", sessionID: "ob", playerID: "ob", url: "https://feed.example/", frameSite: "feed.example", pageSite: "feed.example", occurredAtMs: BASE_COUNTING + 10_000, positionSeconds: 10, state: "paused" })
  ];
  const overlapInsight = summarizeViewing(overlapBreakdown, window);
  assertCounting(overlapInsight.activeSeconds === 10, "Overall overlap-safe time is incorrect");
  assertCounting(overlapInsight.videos.length === 2, "Generic sessions were incorrectly merged");
  assertCounting(overlapInsight.videos.reduce((sum, video) => sum + video.activeSeconds, 0) === 10, "Per-video rows do not equal overlap-safe overall time");
  console.log("Dynamic intentional-start counting: PASS");
})();
