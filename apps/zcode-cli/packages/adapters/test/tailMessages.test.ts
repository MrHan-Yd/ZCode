import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { runSqliteSessionMigrations } from "../src/storage/session-store/migration-runner.js";
import { tailMessages } from "../src/storage/session-store/repositories/messages.js";

/**
 * 尾部预览读取：只取最后 N 条，但顺序与 messages() 的尾部截取一致（升序）。
 * NULL sequence 在 messages() 升序里排最后，倒序取尾时必须仍落在末尾。
 */

const SESSION_ID = "sess-tail-preview";

function createDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  runSqliteSessionMigrations(db, ":memory:");
  db.prepare(
    `insert into session (id, project_id, slug, directory, title, version, time_created, time_updated)
     values (?, 'project', 'slug', 'D:/workspace', 'title', '0.0.0', 0, 0)`,
  ).run(SESSION_ID);
  return db;
}

function insertMessage(
  db: DatabaseSync,
  input: { id: string; sequence: number | null; time: number; role?: "user" | "assistant" },
): void {
  const role = input.role ?? "assistant";
  db.prepare(
    `insert into message (id, session_id, time_created, time_updated, data, sequence)
     values (?, ?, ?, ?, ?, ?)`,
  ).run(
    input.id,
    SESSION_ID,
    input.time,
    input.time,
    JSON.stringify({ role, time: { created: input.time } }),
    input.sequence,
  );
}

function insertTextPart(db: DatabaseSync, messageID: string, partID: string, text: string): void {
  db.prepare(
    `insert into part (id, message_id, session_id, time_created, time_updated, data, sequence)
     values (?, ?, ?, 0, 0, ?, 0)`,
  ).run(partID, messageID, SESSION_ID, JSON.stringify({ type: "text", text }));
}

test("返回最后 limit 条消息，保持升序且带 parts", async () => {
  const db = createDb();
  for (let index = 1; index <= 5; index += 1) {
    const id = `msg-${index}`;
    insertMessage(db, { id, sequence: index, time: index });
    insertTextPart(db, id, `part-${index}`, `text-${index}`);
  }

  const tail = await tailMessages(db, { sessionID: SESSION_ID as never, limit: 2 });
  assert.deepEqual(
    tail.map((message) => message.info.id),
    ["msg-4", "msg-5"],
  );
  assert.deepEqual(
    tail.map((message) => message.parts.length),
    [1, 1],
  );
  db.close();
});

test("NULL sequence 的消息仍按 messages() 全序排在最后", async () => {
  const db = createDb();
  insertMessage(db, { id: "msg-1", sequence: 1, time: 1 });
  insertMessage(db, { id: "msg-null", sequence: null, time: 99 });

  const tail = await tailMessages(db, { sessionID: SESSION_ID as never, limit: 1 });
  assert.deepEqual(
    tail.map((message) => message.info.id),
    ["msg-null"],
  );
  db.close();
});

test("limit <= 0 返回空数组", async () => {
  const db = createDb();
  insertMessage(db, { id: "msg-1", sequence: 1, time: 1 });
  assert.deepEqual(await tailMessages(db, { sessionID: SESSION_ID as never, limit: 0 }), []);
  db.close();
});
