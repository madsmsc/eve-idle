'use strict';

// Persistence layer. State is a single JSON document written atomically
// (write to a temp file, then rename over the target) so a crash mid-write
// cannot corrupt the save.

const fs = require('fs');
const path = require('path');

class Store {
  // PUBLIC
  constructor(filePath) {
    this.filePath = filePath;
  }

  // Returns the parsed state, or null if no save exists yet.
  // PUBLIC
  load() {
    let raw;
    try {
      raw = fs.readFileSync(this.filePath, 'utf8');
    } catch (e) {
      if (e.code === 'ENOENT') return null;
      throw e;
    }
    if (!raw || !raw.trim()) return null;
    return JSON.parse(raw);
  }

  // PUBLIC
  save(state) {
    const dir = path.dirname(this.filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const tmp = `${this.filePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
    fs.renameSync(tmp, this.filePath);
  }
}

module.exports = { Store };
