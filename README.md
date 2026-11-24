# ChalkBored lessons

The lesson files for ChalkBored, served from lessons.chalkbored.win.
The main site (Guernica4u/ChalkBored) keeps the card list and covers. This repo only holds the lesson folders.

Each lesson lives at `LESSONS/<Folder>/`, the same path it had in the main repo.

Deploy: `node list-files.mjs && npx wrangler deploy` from this folder.

Offline list: `node list-files.mjs` writes `files.json` (every lesson file and its size) for the offline download script. Run it before each deploy.
