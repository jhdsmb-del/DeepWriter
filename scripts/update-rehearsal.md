# Rehearse a real Windows NSIS update

After these files and the candidate desktop updater are pushed, manually run
**Actions → Windows NSIS update rehearsal → Run workflow**, selecting that branch.
The workflow needs no secrets and has read-only repository permissions. It never
creates a release, uploads a release asset, or changes a tag. With GitHub CLI:

```powershell
gh workflow run update-rehearsal.yml --ref <candidate-branch>
gh run list --workflow update-rehearsal.yml --limit 1
gh run watch <run-id> --exit-status
gh run download <run-id> --name windows-update-rehearsal-<run-id>
```

GitHub must know the manually dispatchable workflow on the repository's default
branch before it can be dispatched on another branch. Push/merge that workflow
first if GitHub reports that it cannot find the workflow.

## What actually runs

The job is restricted to a disposable **GitHub-hosted Windows runner**. Both the
Node entry point and native UI helper reject local/self-hosted execution. Do not
use this as a workstation installation test.

It builds the candidate's desktop output once, then packages **NSIS only** twice:
A has the candidate version (for example 8.0.0), B has its next patch (8.0.1).
These are unsigned, synthetic test copies of the same candidate, not official
release binaries or a test of a previous release's updater. Both include the
candidate's real installer configuration, installation marker, desktop UI,
preload bridge, update state machine and shutdown coordinator.

Only the two disposable packages receive a test-only main bootstrap. It changes
the hidden `NsisUpdater` instance's feed at check time to a private
`127.0.0.1` HTTP fixture and records observations. Shipping `package.json`, source
entry points and release build scripts remain unchanged; the shipping file list
does not contain the bootstrap. The updater's actual download, checksum checks,
quit flags and NSIS installation are not mocked or replaced. Production
`quitAndInstall(false, true)` stays non-silent: a PID/path-scoped native helper
clicks the genuine installer's Next/Install/Finish buttons.

The installation directory and user profile are freshly created beneath
`RUNNER_TEMP`. A deterministic local model stream keeps real writing active
during the download; no model service, API key or payment is used. The test checks:

1. Real silent NSIS installation of A and correct installed-channel detection.
2. A feed outage produces a retryable error without stopping A.
3. Retry downloads B while writing remains active, with real desktop state events.
4. Explicit restart is refused while that writing stream is active; it is not cancelled.
5. After download, ordinary window-close quits naturally without installation;
   reopening the installed executable still runs A, with the saved data.
6. Explicit UI confirmation follows the real draft-flush/shutdown path and launches
   the real upstream NSIS updater. The genuine installer completes and automatically
   starts B. B itself reports its version, packaged UI state and preserved data;
   the running executable path and Windows product version independently match B.
7. User settings, configured-credential marker, conversation and unsent draft survive.
8. Graceful close of B and scoped real NSIS uninstall preserve the fixture database.

## Evidence and acceptance

The run must finish successfully and `result.json` must say `"outcome": "passed"`.
Download the **windows-update-rehearsal-&lt;run-id&gt;** artifact. It contains:

- `result.json`: candidate source commit, synthetic versions and completed checks.
- Screenshots of offline/retry, concurrent writing/download, refused busy restart,
  explicit confirmation, and the automatically restarted packaged UI.
- `desktop-update-states.json`, `updater-events.jsonl`, `http-requests.json`:
  observed main/preload/UI phases, original upstream calls and loopback requests.
- `restarted-identity.json`: actual B process ID/path, Windows product version and
  B's own renderer data snapshot.
- `native-Installer.json` and its log: actual wizard button actions, scoped to
  the downloaded updater executable's path rather than an image name.
- Shutdown traces and test-builder configurations for diagnosis.

Artifacts omit both large installers, credential values, settings files and the
profile database. On failure, the same artifact is uploaded with completed checks
and the specific failed stage; a prepared workflow alone is not a successful
rehearsal. Unsigned fixture packages do not validate release signing, public
GitHub feed publication, or updates from a previously shipped binary.

Local non-installing helper checks are safe:

```powershell
node --test scripts/update-rehearsal.test.cjs
```
