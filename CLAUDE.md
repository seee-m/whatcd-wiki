# Build versioning

`api/src/buildNumber.ts` exports `BUILD_NUMBER`, shown in the site footer as
"Build N" next to the lifetime visitor count (served together by
`GET /api/visitor-count`, see `api/src/routes/visitors.ts` and
`web/src/components/Layout.tsx`).

**Increment `BUILD_NUMBER` by 1 once per commit, right before committing** --
not per edit within a session. Several edits made before a commit should
only bump it once, so the number tracks deploys/commits, not intermediate
working-tree changes.
