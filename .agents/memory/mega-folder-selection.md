---
name: MEGA folder selection
description: Durable behavior for interactive MEGA folder browsing and uploads.
---

Interactive folder browsing must complete the recursive metadata scan before any file download begins. Keep the selected folder/file node references in the active browser session, and derive the upload list from selected folder ancestry so selecting a parent includes descendants while unrelated branches remain excluded.

**Why:** Folder links can contain unsupported files, nested branches, and duplicate names; downloading before selection violates the user flow and makes filtering unreliable.

**How to apply:** For future folder-browser changes, preserve metadata-only discovery, explicit Start Upload gating, ancestor-based recursive inclusion, and the supported-video extension allowlist.