# Milestone A engineering decisions

- **Node.js (DEP-02):** Node 24 LTS, starting at 24.13.0, is the tested
  development baseline. The supported range is restricted to that LTS major
  until other versions are tested. The package name is provisional and private;
  the owner has not selected a final package name or project license.
- **Tooling:** TypeScript is strict, ESLint checks the code, and Node's built-in
  test runner runs offline tests. The lockfile pins the dependency tree.
- **Dependency advisories:** `npm audit` reports a moderate minimatch
  denial-of-service advisory in development tooling and a low-severity cookie
  validation advisory in the upstream helper's production dependency tree.
  The helper pins cookie to the 0.6 range; do not use a forced downgrade of the
  Alexa library as a security fix. Reassess before release and live login.
- **Secret scanning (SEC-09):** Install Gitleaks separately, then run
  `npm run scan:secrets` before committing. It scans repository files, including
  untracked files, with findings redacted; generated output and installed
  dependencies are excluded. Review artifacts for private data separately:
  secret scanning is not a substitute for privacy review or protected storage.
- **Alexa dependencies (DEP-02):** Reviewed the current npm releases on
  2026-11-13 and pinned `alexa-remote2` 8.1.1 and its `alexa-cookie2` helper
  5.0.6 exactly. The remote library's own dependency resolves to the same
  helper in the lockfile. These releases include login redirect and two-factor
  fixes; this is source/release-note evidence, not live verification.
  [Remote release](https://github.com/Apollon77/alexa-remote/releases/tag/v8.1.1);
  [helper release](https://github.com/Apollon77/alexa-cookie/releases/tag/v5.0.6).
- **License review (OSS-02):** Both direct Alexa packages declare MIT. The
  locked dependency tree also declares MIT, Apache-2.0, BSD-2-Clause,
  BSD-3-Clause, ISC, BlueOak-1.0.0 and Public Domain licenses; no package in
  the lockfile lacks a declared license. Preserve applicable license texts and
  notices in a future distribution and perform a final dependency/notice review
  before release.
  No project license has been selected.
- **Logging (SEC-06):** The proof logs only fixed event names. All untrusted
  details are replaced wholesale rather than relying on patterns to recognize
  every possible secret, household label, or upstream error.
- **Credential protection (AUTH-03):** The local store writes plaintext session
  data only inside an owner-restricted directory outside Git worktrees. It
  checks file and directory permissions and atomically replaces the session
  file. OS permissions, not encryption, provide the protection; an adjacent
  encryption key would not improve protection against equivalent filesystem
  access. Windows ACL behavior was tested locally; Linux permissions still
  require testing on Linux before claiming that platform is supported.
