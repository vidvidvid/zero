# CLAUDE.md

For agents working in this repository. The README says what zero is and why;
this is the part you'd otherwise have to rediscover.

## Releasing — nothing on `main` reaches anyone

The only trigger is a tag. `.github/workflows/release.yml` runs on
`push: tags: v*`, builds the dmg on a macOS arm64 runner in about two minutes,
and attaches it as `zero_aarch64.dmg`. The public download —

```
https://github.com/vidvidvid/zero/releases/latest/download/zero_aarch64.dmg
```

— resolves to the newest **release**, which is the newest tag, not the newest
commit. Merging to main changes nothing anyone can download.

**So: after shipping something a user would notice, ask whether it's worth a
release.** Not every commit is, but a change nobody can install is a change
nobody has.

To cut one, bump the version in all three places — `package.json`,
`src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml` — then:

```sh
git tag -a v0.2.0 -m "zero 0.2.0"
git push origin main --follow-tags
```

The workflow checks the three against the tag before it builds anything and
fails loudly if they disagree. That check exists because three copies of one
number drift quietly.

The Homebrew cask lives in its own repository, `vidvidvid/homebrew-zero`, and
pins both the version and the dmg's sha256. **It does not follow releases** —
a new tag means editing the cask too, or `brew install --cask` goes on handing
people the old dmg. The sha256 is printed in the release notes so you don't
have to download the file to get it. (That repository doesn't exist yet; the
cask is written and lint-clean but unpublished.)

## Building and installing locally

- **Never quit or relaunch the installed app.** There may be live Claude Code
  sessions in its terminals. Install, say it's installed, and let Vid relaunch
  it himself.
- **Install atomically** — copy beside, then swap. A `rm -rf` followed by a
  `cp` leaves no app at all if the copy fails:
  ```sh
  rm -rf /Applications/zero.app.new
  cp -R src-tauri/target/release/bundle/macos/zero.app /Applications/zero.app.new
  rm -rf /Applications/zero.app
  mv /Applications/zero.app.new /Applications/zero.app
  ```
- **Never chain `&&` after a piped build.** `npm run tauri build | tail && …`
  reports the pipe's status, not the build's, so a failed build runs the next
  command anyway. Use `set -o pipefail`.
- **Show it in `npm run tauri dev` first**, and wait for an explicit go-ahead
  before building, installing or pushing. Praise for the plan isn't it.

## Numbers in the docs are measured, not estimated

README and BENCHMARKS quote bundle sizes, file counts and timings. If a change
could move one, re-measure it and update both — a stale number in a document
that exists to be precise costs more than no number.

## The icon

`src-tauri/icons/zero-icon.py` draws every icon the app ships and is the only
place any of them is edited. `Assets.car` is the compiled macOS 26 icon and is
committed deliberately, so a build never invokes `actool` — Apple's is
intermittently broken and takes every build with it. The README's "The icon"
section has the whole story.
