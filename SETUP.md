# GitHub Setup — Run These Commands

## One-time setup

```bash
# 1. Create GitHub repo (do this on github.com first, or via CLI:)
gh repo create nokhda-dubai --public --description "Dubai Property Intelligence Platform"

# 2. Add remote and push
cd nokhda-dubai
git remote add origin https://github.com/YOUR_USERNAME/nokhda-dubai.git
git push -u origin main
```

## Enable GitHub Pages

Go to: **Settings → Pages → Source → GitHub Actions**

Your site will be live at: `https://YOUR_USERNAME.github.io/nokhda-dubai/`

## Future updates — just run:

```bash
# Edit index.html, then:
git add index.html
git commit -m "feat: describe your change"
git push
# GitHub Actions auto-deploys in ~30 seconds
```
