# Build versioning

`api/src/buildNumber.ts` exports `BUILD_NUMBER`, shown in the site footer as
"Build N" next to the lifetime visitor count (served together by
`GET /api/visitor-count`, see `api/src/routes/visitors.ts` and
`web/src/components/Layout.tsx`).

**Whenever you make a code change in this repo, increment `BUILD_NUMBER` by
1 in the same change**, so the footer always reflects the latest build.
