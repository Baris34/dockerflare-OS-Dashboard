import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { openStore } from "../../../lib/store.mjs";

export function checkDatabase(file) {
  // Read-only open fails for a missing database. Also reject an unrelated or uninitialized file.
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const tables = db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name IN ('state','events','samples')").all();
    assert.equal(tables.length, 3, "Hedefte hazır bir Halkness veritabanı gerekli");
    db.prepare("SELECT request_id, trace_id, operation FROM events LIMIT 0");
  } finally {
    db.close();
  }
}

export function importEvents(file, events) {
  checkDatabase(file);
  const store = openStore(file);
  try {
    let added = 0;
    function copy() {
      const before = added;
      store.batch(() => {
        for (const event of events) {
          const params = new URLSearchParams({ trace_id: event.trace_id, limit: "200" });
          const matches = store.events(params).items.filter(row => row.request_id === event.request_id &&
            row.source === event.source && row.service === event.service && row.operation === event.operation);
          if (matches.length) {
            assert.equal(matches.length, 1);
            for (const key of Object.keys(event)) assert.equal(matches[0][key], event[key]);
          } else {
            store.record(event);
            added++;
          }
        }
      });
      return added - before;
    }
    const count = copy();
    assert.equal(copy(), 0, "Tekrar içe aktarımda çift kayıt");
    return count;
  } finally {
    store.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv[2] === "--check") checkDatabase("/data/seyir.sqlite");
  else console.log(importEvents("/data/seyir.sqlite", JSON.parse(readFileSync(0, "utf8"))));
}
