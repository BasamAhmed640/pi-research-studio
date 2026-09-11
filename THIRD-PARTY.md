# Upstream components

Research Studio is independent of these projects and is not endorsed by their authors.

| Component | Version | Integration | License |
| --- | --- | --- | --- |
| [Pi Web Access](https://github.com/nicobailon/pi-web-access) | 0.29.0 | Unmodified npm dependency, tools exposed only while Studio is active; curator disabled for direct questions | MIT, Nico Bailon |
| [Visual Explainer](https://github.com/nicobailon/visual-explainer) | 0.11.0 | Unmodified npm dependency, official local MCP server with vault-scoped output | MIT, Nico Bailon |
| [Feynman](https://github.com/advaitpaliwal/feynman) | npm 0.3.48 | Original researcher, verifier and reviewer prompts in `vendor/feynman`; native Pi runs the roles | MIT, Companion, Inc. |
| [Pi Agent for Obsidian](https://github.com/ChristianLempa/obsidian-pi) | 0.0.13 | Exact release assets in `vendor/obsidian-pi`; optional Obsidian chat interface | MIT, upstream license included |
| [unpdf](https://github.com/unjs/unpdf) | 1.8.1 | Local PDF text extraction | MIT |

Feynman's original role files are preserved byte-for-byte. Studio adds an explicit runtime adaptation: general subjects are supported; only available tools may be used; a failed search does not establish nonexistence; the lead writes files and resolves review findings; routine plan approval and recursive delegation are excluded. Its evidence → draft → verification → review approach informs Deep mode. The complete Feynman application and its runtime are **not** included.

Original licenses accompany the vendored files. npm dependency licenses remain with their packages. `upstream-lock.json` records versions, source repositories and SHA-256 hashes for the vendored assets; `package-lock.json` records npm dependency integrity.
