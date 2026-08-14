# CLAUDE.md

For agents working in this repository. The README says what zero is and why;
this is the part you'd otherwise have to rediscover.

## Releasing — nothing on `main` reaches anyone

The only trigger is a tag. `.github/workflows/release.yml` runs on
`push: tags: v*`, builds the dmg on a macOS arm64 runner in about two minutes,
and attaches it as `zero_aarch64.dmg`. The public download —

```
https://github.com/zero-editor/zero/releases/latest/download/zero_aarch64.dmg
```

— resolves to the newest **release**, which is the newest tag, not the newest
commit. Merging to main changes nothing anyone can download.

**So: after shipping something a user would notice, ask whether it's worth a
release.** Not every commit is, but a change nobody can install is a change
nobody has.

To cut one, from a clean tree on `main`:

```sh
npm version 0.2.0 -m "zero %s"   # bumps package.json, commits, tags v0.2.0
git push origin main --follow-tags
```

That is the release, but not the end of it — the cask block below has to run
too, or brew users stay on whatever the last bumped version was.

`package.json` is the only copy of the version. `tauri.conf.json` names it as a
path rather than repeating the number, and `Cargo.toml` sits at `0.0.0` because
nothing reads it. The workflow checks the tag against `package.json` — and
checks that `tauri.conf.json` still points at it, since a literal number put
back there would go stale with nothing to notice.

The Homebrew cask lives in its own repository, `zero-editor/homebrew-tap`, and
pins both the version and the dmg's sha256. **It does not follow releases** —
a new tag means bumping `version` and `sha256` in `Casks/zero.rb` and pushing
that repository too, or `brew install --cask` goes on handing people the old
dmg. The sha256 is printed in the release notes so you don't have to download
the file to get it, and `brew fetch --cask zero-editor/tap/zero` checks the two
agree without installing anything.

**The tag is half a release. Run this before calling one done** — it waits for
the build, reads the sha256 out of the release notes, and bumps the cask. It is
idempotent, so run it whenever the two might have drifted:

```sh
V=$(node -p "require('./package.json').version")
gh run watch --exit-status \
  "$(gh run list --workflow=release.yml --limit 1 --json databaseId -q '.[0].databaseId')"
SHA=$(gh release view "v$V" --repo zero-editor/zero --json body -q .body | awk '/sha256/{print $2}')
TAP=$(brew --repository zero-editor/tap)   # or clone zero-editor/homebrew-tap
git -C "$TAP" pull --ff-only
sed -i '' -e "s/^  version \".*\"/  version \"$V\"/" \
          -e "s/^  sha256 \".*\"/  sha256 \"$SHA\"/" "$TAP/Casks/zero.rb"
git -C "$TAP" commit -am "zero $V" && git -C "$TAP" push
brew fetch --cask zero-editor/tap/zero     # ✔︎ only if the dmg matches the sha256
```

Nothing enforces this — no CI watches the tap — so it is only ever as reliable
as running it. 0.4.0 shipped without it and brew went on installing 0.3.1, with
every check green, because none of them look. The `brew fetch` line is the one
that would have caught it: it is the only step that compares the cask against
the file people actually download.

The same question goes to anything else pinning a version or a checksum. Today
that is the cask and nothing else, so this is the whole list — but the way it
gets missed is assuming it still is.

## Updating in place — the release has a second audience

An installed copy checks
`/releases/latest/download/latest.json` on launch and every six hours, and if
there's a newer version it downloads and stages it silently. What appears in
the titlebar is a restart, not a download — the waiting is already over by the
time anyone sees it. `src/lib/update.ts` is the whole of the frontend half.

The restart is never automatic, and that is the point rather than an
omission. Restarting zero closes every terminal in it, and a terminal here may
be holding a Claude session mid-task, so the button arms on the first click and
says what it costs — the live session count comes from the `claude_status` poll
the tab strip already runs — and only the second click relaunches. The same
rule as the one further down about the installed app: it is not ours to quit.

Three artifacts go up per release, not one. The dmg is for a new user; the
updater reads `zero.app.tar.gz` (the same bundle, signed and notarized and
stapled — the workflow extracts and re-checks it with `stapler validate` and
`spctl` before publishing, because tauri treats missing notarization as a
warning) and `latest.json`, which names the *tagged* tarball URL and carries
its minisign signature. Nothing outside GitHub serves any of it.

A self-updated copy drifts from the Homebrew cask, which pins a version: brew
will still believe whatever `Casks/zero.rb` says until it is bumped, and
`brew upgrade` will reinstall over a newer app. Not harmful, and another reason
the cask block above is not optional.

Always write the install command fully qualified. Homebrew refuses casks from
non-official taps unless you name the tap on the command line — naming it *is*
the consent signal (`Homebrew::Trust.explicitly_allowed?`). A shortened
`brew tap` + `brew install --cask zero` makes users run `brew trust` first.

The only real shortening is homebrew/cask itself, and the gate is a number,
not a judgment: `brew audit --cask --new --online zero-editor/tap/zero` is the
audit their CI runs on submissions, and run against the real cask it fails on
exactly one problem — "GitHub repository not notable enough (<30 forks, <30
watchers and <75 stars)". Any one of the three clears it. Everything else
already passes, so at 75 stars the submission is one PR whose CI outcome is
known.

Submit it as `zero-editor`, not `zero`: a homebrew/core formula already owns
`zero` — another coding agent, actively installed — and bare `brew install`
resolves formulae first, so that token would need `--cask` forever even if
granted. `zero-editor` is free on both sides (measured: formulae.brew.sh 404s
for it as cask and formula), and with no formula sharing the name, bare
`brew install zero-editor` resolves to the cask, no flag needed.

## Signing — it happens in CI and nowhere else

Released dmgs are signed with a Developer ID Application certificate and
notarized, which is what keeps macOS from calling the download damaged. Six
repository secrets drive it, and the release fails on the first missing one
rather than shipping a dmg that only the downloader discovers is unsigned:

| secret | what it is |
|---|---|
| `APPLE_CERTIFICATE` | the Developer ID `.p12`, base64 |
| `APPLE_CERTIFICATE_PASSWORD` | the password given when exporting it |
| `APPLE_SIGNING_IDENTITY` | `Developer ID Application: … (TEAMID)`, exactly as `security find-identity -v -p codesigning` prints it |
| `APPLE_API_KEY` | App Store Connect key ID |
| `APPLE_API_ISSUER` | App Store Connect issuer ID |
| `APPLE_API_KEY_P8` | the `.p8` key file, base64 |
| `TAURI_SIGNING_PRIVATE_KEY` | the updater's minisign private key (see below) |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | the password it was generated with |

The last two are **not** Apple's, and not interchangeable with them. The
updater verifies its downloads with a minisign keypair of its own, generated by
`tauri signer generate`; the public half sits in `tauri.conf.json` and the
private half is those two secrets. Local copies are `~/.tauri/zero.key` and
`~/.tauri/zero.key.password` on Vid's Mac.

**That key has no recovery path, and it is the only credential here that
doesn't.** A lost certificate is re-issued from Xcode in a few minutes. A lost
updater key can't be re-issued at all: every installed copy has the matching
public key compiled into it, so a new keypair means every existing install
rejects every future update and has to be replaced by hand. Back it up
somewhere that isn't this machine.

**Keychain Access is gone in macOS 26**, and with it every set of instructions
on the internet that starts "Certificate Assistant → Request a Certificate".
The certificate is made in Xcode instead: Settings → Accounts → the team →
Manage Certificates → `+` → Developer ID Application, then right-click it →
Export Certificate for the `.p12`. Apple allows five per team, so they aren't
free to make and throw away.

**The certificate expires 1 February 2027.** Not the five years these are
usually described as having — Apple issued this one short, so check rather than
assume. The notarization key doesn't expire at all, which makes the certificate
the thing that breaks first, and it breaks as a failed release rather than as a
bad dmg. To re-read the date from the Mac that holds it:

```sh
security find-certificate -c "Developer ID Application" -p |
  openssl x509 -noout -enddate
```

Local builds stay unsigned, deliberately: tauri only signs when it finds these
in the environment, so `npm run tauri build` costs nothing extra and needs no
keychain. The one visible consequence is that macOS re-asks for the microphone
after every local rebuild — TCC remembers permission per signature, and an
ad-hoc one is new each time.

Two things about this are not obvious from tauri's documentation, and both are
load-bearing:

- **Notarization requires the hardened runtime, and the hardened runtime
  requires an entitlement for the microphone.** `src-tauri/Entitlements.plist`
  is that file, and it exists for `zero-voice` more than for zero — the sidecar
  is the process that opens the mic. The bundler signs every Mach-O in the
  bundle with it, sidecars first and the app last, so one file covers both.
- **tauri notarizes the `.app` and never the `.dmg` around it.** macOS checks
  the disk image too, so the workflow signs, notarizes and staples the dmg
  itself after the build. The `spctl` step that follows is the check that this
  really happened: tauri downgrades missing notarization credentials to a
  warning and signs anyway, and a signed-but-unnotarized dmg looks perfectly
  fine until someone downloads it.

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
