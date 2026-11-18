# Chrome rebuild domain API

The pre-existing Swift app and `BrowserExtension/` remain legacy and are not imported by the Chrome-only rebuild.

Developer B can import public APIs from `lib/index.js`:

- `validatePlaybackEvent(payload)` before every repository write. The strict v1 event contains: `eventID`, `sessionID`, `playerID`, `tabID`, `frameID`, `frameSite`, `pageSite`, `url`, `mediaTitle`, playback metrics, state, visibility and tab-active state. Unknown fields are rejected.
- `IndexedDBRepository` / `InMemoryRepository`: `putEvent`, `listEvents`, analysis job/result CRUD, `prune`, `exportData`, and `deleteAll`.
- `dayWindow`, `weekWindow`, `summarizeViewing`, `activeSessionSeconds`.
- `normalizeSettings`, `DEFAULT_SETTINGS`, `isExcludedSite`, and `safeSettingsExport`.
- `NudgeEngine`, `distinctSessionsInWindow`, and `aiEvidenceFromResult`. Slow/skip nudges require the latter’s validated AI evidence.
- `createAnalysisJob`, `transitionAnalysisJob`, `restartAction`, `validateAnalysisResult`, and analysis constants.

No module performs network calls. API keys are deliberately absent from domain models, IndexedDB records, and exports.
