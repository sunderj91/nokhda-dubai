# Nokhda — Dubai Property Intelligence

A real-time Dubai real estate analytics platform with interactive map, DLD transaction data, AI-powered listings, and portfolio simulator.

**Live site:** https://[your-username].github.io/nokhda-dubai/

## Features
- 🗺️ **Interactive Map** — MapLibre GL with accurate Dubai district boundaries, heatmap by PSF/Yield/YoY/Volume
- 🏙️ **15 Landmark Projects** — Off-plan & completed with price history charts
- 📊 **17 Areas** — DLD 2024 data: 226,000 transactions, AED 761B total value
- 🏠 **Listings Tab** — For-sale & for-rent with AI-powered search
- 📋 **Transactions Tab** — Live DLD transaction feed with H1 2025 summary
- 💼 **Portfolio Simulator** — Mortgage leverage, cashflow, IRR, exit scenarios
- 📄 **PDF Reports** — Branded client reports

## Data Sources
- Dubai Land Department (DLD) Open Data
- Property Monitor DPI
- Bayut 2024/2025 Annual Report
- Knight Frank Q3 2025

## Tech Stack
- MapLibre GL JS 4.5 (open-source Mapbox fork — no API key needed)
- Deck.gl 9.0 (WebGL data layers)
- CARTO Dark Matter / Voyager base tiles
- Vanilla JS, no framework dependencies

## Deployment
Hosted on GitHub Pages. Single-file HTML — just push `index.html`.

## Roadmap
- [ ] Live DLD API integration (Dubai Pulse OAuth)
- [ ] Bayut RapidAPI listings feed
- [ ] Property comparison tool
- [ ] Mortgage calculator with bank rate comparison
- [ ] Arabic language support

## License
MIT
