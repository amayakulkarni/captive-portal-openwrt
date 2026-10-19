# Publishing this project to GitHub

A checklist for putting `openwrt-captive-portal/` on GitHub safely. Work in this folder only;
the original project folder next to it still holds real credentials and device data and must
never be pushed.

## 0. Before you publish anything

1. **Rotate the old credentials.** The original `app.js` contained a real admin API key and
   family password. Treat them as exposed: set new values in `portal.env` on the router.
2. **Confirm nothing private is in this folder:**
   ```sh
   cd openwrt-captive-portal
   grep -rnEi "password|api_key|secret" --exclude-dir=node_modules --exclude=*.md .
   grep -rnE "([0-9a-f]{2}:){5}[0-9a-f]{2}" --exclude-dir=node_modules .
   ```
   Expect only variable names and the `02:00:00:...` example MACs.
3. **Set the license name.** Replace `[Your Name]` in `LICENSE` (or switch license).
4. **Check you actually want these public:** subnet layout defaults, mDNS/casting rules, and the
   architecture are all visible in the repo. They are generic RFC1918 defaults here.

## 1. Create the repository

On GitHub: **New repository** -> name e.g. `openwrt-captive-portal` -> **do not** add a README,
.gitignore or license (they already exist) -> Create.

## 2. Initialize and commit locally

```sh
cd openwrt-captive-portal
git init -b main
git add .
git status          # verify: no portal.env, networks.json, seed/devices.json, node_modules
git commit -m "Initial commit: multi-subnet OpenWrt captive portal"
```

If `git status` lists any of those files, stop and fix `.gitignore` first.

## 3. Push

HTTPS (with a personal access token or GitHub CLI login):

```sh
git remote add origin https://github.com/<you>/openwrt-captive-portal.git
git push -u origin main
```

Or with the GitHub CLI: `gh repo create openwrt-captive-portal --public --source=. --push`
(use `--private` to start private, which is a sensible default for a first push).

## 4. Polish the repo page

- **About** box: description, topics `openwrt`, `captive-portal`, `nftables`, `nodejs`, `banana-pi-bpi-r3`
- Add a screenshot of the portal and admin pages under `docs/` and embed in the README
- Enable **Settings -> Code security -> Secret scanning / push protection**
- Optionally add a `SECURITY.md` pointing to private vulnerability reporting
- Tag a release: `git tag v1.0.0 && git push --tags`

## 5. If a secret ever gets committed

Deleting it in a later commit is not enough: it stays in history. Rotate the secret first, then
remove it from history (`git filter-repo --path portal.env --invert-paths`, or recreate the repo)
and force-push.

## 6. Keeping private deployment data separate

Keep your real `portal.env`, `seed/devices.json` and `networks.json` only on the router and in a
private backup. They are gitignored here, so day-to-day `git add .` stays safe.
