# Context Panel + Rewind Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Redesign the context panel (remove conversation history, polish buttons/headers) and add a hover-reveal rewind icon to user messages that soft-hides messages after a turn and restores the workspace snapshot; the review dashboard shows collapsed rewind blocks inline.

**Architecture:** Add a `rewound_at` column to the `messages` table (soft-flag, not delete). The backend exposes `POST /api/sessions/:id/rewind` to set it. The frontend's `ChatPanel` filters rewound messages from the active view, restores the user's text to the textarea, and calls workspace restore via `App.tsx`. The `ReviewDashboard` fetches all messages including rewound ones and renders collapsible rewind blocks.

**Tech Stack:** TypeScript, better-sqlite3, pg, React, Tailwind CSS, lucide-react

---

## File Map

| File | Change |
|------|--------|
| `packages/core/src/database.ts` | Add `rewound_at` to schema, `StoredMessage`, `DatabaseAdapter.rewindMessages`, update `getBranchMessages` signature |
| `packages/backend/src/routes/api.ts` | Add `POST /sessions/:id/rewind`; update `GET /review/:id` to include raw messages |
| `packages/backend/src/app.test.ts` | Add `rewindMessages` stub to mock adapter |
| `packages/backend/src/replay.test.ts` | Add `rewindMessages` stub to mock adapter |
| `packages/frontend/src/lib/session-persist.ts` | Add `turnSequence` param to `restoreFiles` |
| `packages/frontend/src/App.tsx` | Add `handleRewind` callback |
| `packages/frontend/src/components/ChatPanel.tsx` | Rewind icon + popover on user messages; context panel redesign |
| `packages/frontend/src/lib/review-replay.ts` | Add `raw_messages` to `ReviewDataPayload` |
| `packages/frontend/src/components/ReviewDashboard.tsx` | Rewound blocks in conversation panel |

---

## Task 1: Add `rewound_at` to schema and `DatabaseAdapter` interface

**Files:**
- Modify: `packages/core/src/database.ts`

- [ ] **Step 1: Add `rewound_at` to `StoredMessage` and `MessageRow`**

In `packages/core/src/database.ts`, find the `StoredMessage` interface (around line 26) and add the field:

```ts
export interface StoredMessage {
  id: number;
  session_id: string;
  branch_id: string;
  conversation_id: string;
  turn_sequence: number | null;
  role: MessageRole;
  content: string;
  token_count: number;
  created_at: number;
  rewound_at: number | null; // Unix ms — set when message is soft-hidden by a rewind
}
```

Find `interface MessageRow` (around line 206) and add:

```ts
interface MessageRow {
  id: number;
  session_id: string;
  branch_id: string;
  conversation_id: string;
  turn_sequence: number | null;
  role: string;
  content: string;
  token_count: number;
  created_at: number;
  rewound_at: number | null;
}
```

- [ ] **Step 2: Add `rewindMessages` and update `getBranchMessages` in `DatabaseAdapter` interface**

Find the `DatabaseAdapter` interface (around line 124). Update `getBranchMessages` signature and add `rewindMessages` after it:

```ts
getBranchMessages(
  sessionId: string,
  branchId: string,
  conversationId?: string,
  options?: { includeRewound?: boolean },
): Promise<StoredMessage[]>;
rewindMessages(
  sessionId: string,
  branchId: string,
  conversationId: string,
  afterTurnSequence: number,
): Promise<void>;
```

- [ ] **Step 3: Add SQLite migration for `rewound_at`**

In `applySqliteMigrations()` (around line 566), add to the `migrations` array:

```ts
const migrations = [
  'ALTER TABLE messages ADD COLUMN branch_id TEXT',
  'ALTER TABLE messages ADD COLUMN turn_sequence INTEGER',
  'ALTER TABLE messages ADD COLUMN conversation_id TEXT',
  'ALTER TABLE replay_events ADD COLUMN branch_id TEXT',
  'ALTER TABLE replay_events ADD COLUMN turn_sequence INTEGER',
  'ALTER TABLE replay_events ADD COLUMN conversation_id TEXT',
  'ALTER TABLE messages ADD COLUMN rewound_at INTEGER',  // ← add this line
];
```

- [ ] **Step 4: Add Postgres migration for `rewound_at`**

In `bootstrapSchema()` in `PostgresAdapter` (around line 2114), add after the existing `ALTER TABLE` calls:

```ts
await this.pool.query('ALTER TABLE messages ADD COLUMN IF NOT EXISTS rewound_at BIGINT');
```

- [ ] **Step 5: Verify TypeScript compiles**

Run: `npm run typecheck --workspace=packages/core`

Expected: type errors about `getBranchMessages` and `rewindMessages` not being implemented in `SQLiteAdapter` and `PostgresAdapter`. That's expected — we'll fix in Tasks 2 and 3.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/database.ts
git commit -m "feat: add rewound_at column to messages schema and DatabaseAdapter interface"
```

---

## Task 2: Implement `rewindMessages` and update `getBranchMessages` in `SQLiteAdapter`

**Files:**
- Modify: `packages/core/src/database.ts` (SQLiteAdapter class, around lines 965–984)

- [ ] **Step 1: Write the failing test**

In `packages/core/src/database.test.ts`, add at the end of the SQLiteAdapter describe block:

```ts
it('rewindMessages soft-hides messages after a turn sequence', async () => {
  const db = new SQLiteAdapter(':memory:');
  const { id: sessionId } = await db.createSession({
    prompt_id: 'p1',
    candidate_email: 'a@b.com',
    constraint: { max_session_tokens: 1000, max_message_tokens: 500, max_interactions: 10, context_window: 8000, time_limit_minutes: 60 },
  });
  const branch = await db.getMainBranch(sessionId);
  const conversation = await db.getMainConversation(sessionId, branch!.id);
  await db.addBranchMessage(sessionId, branch!.id, 1, 'user', 'first', 0, conversation!.id);
  await db.addBranchMessage(sessionId, branch!.id, 1, 'assistant', 'reply', 0, conversation!.id);
  await db.addBranchMessage(sessionId, branch!.id, 2, 'user', 'second', 0, conversation!.id);
  await db.addBranchMessage(sessionId, branch!.id, 2, 'assistant', 'reply2', 0, conversation!.id);

  await db.rewindMessages(sessionId, branch!.id, conversation!.id, 1);

  const visible = await db.getBranchMessages(sessionId, branch!.id, conversation!.id);
  expect(visible).toHaveLength(2);
  expect(visible.every((m) => m.turn_sequence === 1)).toBe(true);

  const all = await db.getBranchMessages(sessionId, branch!.id, conversation!.id, { includeRewound: true });
  expect(all).toHaveLength(4);
  expect(all.filter((m) => m.rewound_at !== null)).toHaveLength(2);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test --workspace=packages/core -- --reporter=verbose 2>&1 | grep -E "PASS|FAIL|rewindMessages"`

Expected: FAIL — `rewindMessages is not a function`

- [ ] **Step 3: Implement `getBranchMessages` with `includeRewound` option in `SQLiteAdapter`**

Replace the existing `getBranchMessages` method in `SQLiteAdapter` (around line 965):

```ts
getBranchMessages(
  sessionId: string,
  branchId: string,
  conversationId?: string,
  options?: { includeRewound?: boolean },
): Promise<StoredMessage[]> {
  const includeRewound = options?.includeRewound ?? false;
  const rewoundFilter = includeRewound ? '' : 'AND rewound_at IS NULL';

  const rows = conversationId
    ? this.db.prepare(
        `SELECT * FROM messages WHERE session_id = ? AND branch_id = ? AND conversation_id = ? ${rewoundFilter} ORDER BY id ASC`,
      ).all(sessionId, branchId, conversationId) as MessageRow[]
    : this.db.prepare(
        `SELECT * FROM messages WHERE session_id = ? AND branch_id = ? ${rewoundFilter} ORDER BY id ASC`,
      ).all(sessionId, branchId) as MessageRow[];

  return Promise.resolve(rows.map((r) => ({
    id: r.id,
    session_id: r.session_id,
    branch_id: r.branch_id,
    conversation_id: r.conversation_id,
    turn_sequence: r.turn_sequence === null ? null : Number(r.turn_sequence),
    role: r.role as MessageRole,
    content: r.content,
    token_count: r.token_count,
    created_at: r.created_at,
    rewound_at: r.rewound_at ?? null,
  })));
}
```

- [ ] **Step 4: Implement `rewindMessages` in `SQLiteAdapter`**

Add this method directly after `getBranchMessages` in `SQLiteAdapter`:

```ts
rewindMessages(
  sessionId: string,
  branchId: string,
  conversationId: string,
  afterTurnSequence: number,
): Promise<void> {
  this.db.prepare(
    'UPDATE messages SET rewound_at = ? WHERE session_id = ? AND branch_id = ? AND conversation_id = ? AND turn_sequence > ?',
  ).run(Date.now(), sessionId, branchId, conversationId, afterTurnSequence);
  return Promise.resolve();
}
```

Also update `getMessages` (uses `getBranchMessages`) — no change needed, it calls without options so defaults apply correctly.

- [ ] **Step 5: Run tests**

Run: `npm run test --workspace=packages/core -- --reporter=verbose 2>&1 | grep -E "PASS|FAIL|rewind"`

Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/database.ts
git commit -m "feat: implement rewindMessages and includeRewound option in SQLiteAdapter"
```

---

## Task 3: Implement `rewindMessages` and update `getBranchMessages` in `PostgresAdapter`

**Files:**
- Modify: `packages/core/src/database.ts` (PostgresAdapter class, around line 1706)

- [ ] **Step 1: Write the failing test**

In `packages/core/src/postgres-adapter.test.ts`, add at the end of the describe block (following the same pattern as the existing tests):

```ts
it('rewindMessages soft-hides messages after a turn sequence', async () => {
  const db = new PostgresAdapter({ pool: testPool });
  await db.initialize();
  const { id: sessionId } = await db.createSession({
    prompt_id: 'p1',
    candidate_email: 'a@b.com',
    constraint: { max_session_tokens: 1000, max_message_tokens: 500, max_interactions: 10, context_window: 8000, time_limit_minutes: 60 },
  });
  const branch = await db.getMainBranch(sessionId);
  const conversation = await db.getMainConversation(sessionId, branch!.id);
  await db.addBranchMessage(sessionId, branch!.id, 1, 'user', 'first', 0, conversation!.id);
  await db.addBranchMessage(sessionId, branch!.id, 1, 'assistant', 'reply', 0, conversation!.id);
  await db.addBranchMessage(sessionId, branch!.id, 2, 'user', 'second', 0, conversation!.id);
  await db.addBranchMessage(sessionId, branch!.id, 2, 'assistant', 'reply2', 0, conversation!.id);

  await db.rewindMessages(sessionId, branch!.id, conversation!.id, 1);

  const visible = await db.getBranchMessages(sessionId, branch!.id, conversation!.id);
  expect(visible).toHaveLength(2);

  const all = await db.getBranchMessages(sessionId, branch!.id, conversation!.id, { includeRewound: true });
  expect(all).toHaveLength(4);
  expect(all.filter((m) => m.rewound_at !== null)).toHaveLength(2);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test --workspace=packages/core -- --reporter=verbose 2>&1 | grep -E "PASS|FAIL|rewindMessages"`

Expected: FAIL

- [ ] **Step 3: Implement `getBranchMessages` with `includeRewound` in `PostgresAdapter`**

Replace the existing `getBranchMessages` method in `PostgresAdapter` (around line 1706):

```ts
async getBranchMessages(
  sessionId: string,
  branchId: string,
  conversationId?: string,
  options?: { includeRewound?: boolean },
): Promise<StoredMessage[]> {
  await this.initialize();
  const includeRewound = options?.includeRewound ?? false;
  const rewoundFilter = includeRewound ? '' : 'AND rewound_at IS NULL';

  const result = conversationId
    ? await this.pool.query<MessageRow>(
        `SELECT * FROM messages WHERE session_id = $1 AND branch_id = $2 AND conversation_id = $3 ${rewoundFilter} ORDER BY id ASC`,
        [sessionId, branchId, conversationId],
      )
    : await this.pool.query<MessageRow>(
        `SELECT * FROM messages WHERE session_id = $1 AND branch_id = $2 ${rewoundFilter} ORDER BY id ASC`,
        [sessionId, branchId],
      );

  return result.rows.map((r) => ({
    id: r.id,
    session_id: r.session_id,
    branch_id: r.branch_id,
    conversation_id: r.conversation_id,
    turn_sequence: r.turn_sequence === null ? null : Number(r.turn_sequence),
    role: r.role as MessageRole,
    content: r.content,
    token_count: r.token_count,
    created_at: Number(r.created_at),
    rewound_at: r.rewound_at === null ? null : Number(r.rewound_at),
  }));
}
```

- [ ] **Step 4: Implement `rewindMessages` in `PostgresAdapter`**

Add after `getBranchMessages` in `PostgresAdapter`:

```ts
async rewindMessages(
  sessionId: string,
  branchId: string,
  conversationId: string,
  afterTurnSequence: number,
): Promise<void> {
  await this.initialize();
  await this.pool.query(
    'UPDATE messages SET rewound_at = $1 WHERE session_id = $2 AND branch_id = $3 AND conversation_id = $4 AND turn_sequence > $5',
    [Date.now(), sessionId, branchId, conversationId, afterTurnSequence],
  );
}
```

- [ ] **Step 5: Run tests**

Run: `npm run test --workspace=packages/core -- --reporter=verbose 2>&1 | grep -E "PASS|FAIL|rewind"`

Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/database.ts
git commit -m "feat: implement rewindMessages and includeRewound option in PostgresAdapter"
```

---

## Task 4: Update mock adapters in backend tests

**Files:**
- Modify: `packages/backend/src/app.test.ts`
- Modify: `packages/backend/src/replay.test.ts`

- [ ] **Step 1: Add `rewindMessages` stub to `app.test.ts`**

In `packages/backend/src/app.test.ts`, find the mock `DatabaseAdapter` class (around line 309). After `getBranchMessages`, add:

```ts
rewindMessages(
  _sessionId: string,
  _branchId: string,
  _conversationId: string,
  _afterTurnSequence: number,
): Promise<void> {
  return Promise.resolve();
}
```

Also update the existing `getBranchMessages` signature in the mock to include the `options` param:

```ts
getBranchMessages(
  sessionId: string,
  branchId: string,
  conversationId?: string,
  _options?: { includeRewound?: boolean },
): Promise<StoredMessage[]> {
  // ... existing body unchanged ...
}
```

And update the `StoredMessage` objects returned to include `rewound_at: null` (find the places where `StoredMessage` objects are constructed in the mock and add the field, or check if TypeScript requires it by running typecheck).

- [ ] **Step 2: Add `rewindMessages` stub to `replay.test.ts`**

In `packages/backend/src/replay.test.ts`, find the mock `DatabaseAdapter` class (around line 292). After `getBranchMessages`, add:

```ts
rewindMessages(
  _sessionId: string,
  _branchId: string,
  _conversationId: string,
  _afterTurnSequence: number,
): Promise<void> {
  return Promise.resolve();
}
```

Update `getBranchMessages` signature to include `_options?: { includeRewound?: boolean }`.

- [ ] **Step 3: Verify tests pass**

Run: `npm run test --workspace=packages/backend 2>&1 | grep -E "PASS|FAIL"`

Expected: all PASS (no new failures)

- [ ] **Step 4: Commit**

```bash
git add packages/backend/src/app.test.ts packages/backend/src/replay.test.ts
git commit -m "fix: add rewindMessages stub to backend test mock adapters"
```

---

## Task 5: Add `POST /api/sessions/:id/rewind` backend endpoint

**Files:**
- Modify: `packages/backend/src/routes/api.ts`

- [ ] **Step 1: Write the failing test**

In `packages/backend/src/app.test.ts`, add a test for the new endpoint (find an existing `POST` endpoint test to follow the pattern):

```ts
it('POST /api/sessions/:id/rewind — marks messages after turn_sequence as rewound', async () => {
  const { sessionId, token } = await createTestSession(db);
  const branch = await db.getMainBranch(sessionId);
  const conversation = await db.getMainConversation(sessionId, branch!.id);
  await db.addBranchMessage(sessionId, branch!.id, 1, 'user', 'msg1', 0, conversation!.id);
  await db.addBranchMessage(sessionId, branch!.id, 2, 'user', 'msg2', 0, conversation!.id);

  const res = await request(app)
    .post(`/api/sessions/${sessionId}/rewind`)
    .set('Authorization', `Bearer ${token}`)
    .send({ turn_sequence: 1 });

  expect(res.status).toBe(200);
  expect(res.body).toEqual({ ok: true });

  const visible = await db.getBranchMessages(sessionId, branch!.id, conversation!.id);
  expect(visible).toHaveLength(1);
  expect(visible[0]!.turn_sequence).toBe(1);
});

it('POST /api/sessions/:id/rewind — 400 if turn_sequence missing', async () => {
  const { sessionId, token } = await createTestSession(db);
  const res = await request(app)
    .post(`/api/sessions/${sessionId}/rewind`)
    .set('Authorization', `Bearer ${token}`)
    .send({});
  expect(res.status).toBe(400);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test --workspace=packages/backend -- --reporter=verbose 2>&1 | grep -E "rewind|FAIL"`

Expected: FAIL — 404

- [ ] **Step 3: Implement the endpoint**

In `packages/backend/src/routes/api.ts`, find `// POST /api/sessions/:id/checkpoints` (around line 1397) and add the rewind endpoint just before it:

```ts
// POST /api/sessions/:id/rewind — soft-hide messages after a turn sequence
router.post('/sessions/:id/rewind', requireToken(db), asyncRoute(async (req, res) => {
  const sessionId = req.params['id'] as string;
  const body = req.body as {
    branch_id?: unknown;
    conversation_id?: unknown;
    turn_sequence?: unknown;
  };

  if (typeof body.turn_sequence !== 'number' || !Number.isInteger(body.turn_sequence)) {
    res.status(400).json({ error: 'turn_sequence must be an integer' });
    return;
  }

  const session = await db.getSession(sessionId);
  if (!session) {
    res.status(404).json({ error: 'Session not found' });
    return;
  }

  const branch = await resolveBranchOrRespond(
    db, res, sessionId,
    typeof body.branch_id === 'string' ? body.branch_id : undefined,
  );
  if (!branch) return;

  const conversation = await resolveConversationOrRespond(
    db, res, sessionId, branch.id,
    typeof body.conversation_id === 'string' ? body.conversation_id : undefined,
  );
  if (!conversation) return;

  await db.rewindMessages(sessionId, branch.id, conversation.id, body.turn_sequence);
  res.json({ ok: true });
}));
```

- [ ] **Step 4: Run tests**

Run: `npm run test --workspace=packages/backend -- --reporter=verbose 2>&1 | grep -E "rewind|PASS|FAIL"`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/backend/src/routes/api.ts
git commit -m "feat: add POST /api/sessions/:id/rewind endpoint"
```

---

## Task 6: Update `GET /api/review/:id` to include raw messages

**Files:**
- Modify: `packages/backend/src/routes/api.ts`
- Modify: `packages/frontend/src/lib/review-replay.ts`

- [ ] **Step 1: Add `raw_messages` to `ReviewDataPayload` in `review-replay.ts`**

In `packages/frontend/src/lib/review-replay.ts`, update the `ReviewDataPayload` interface:

```ts
export interface ReviewDataPayload {
  session: ReviewSessionSummary;
  branch?: { id: string; name: string };
  branches?: Array<{ id: string; name: string }>;
  metrics: ReviewMetric[];
  recording: {
    session_id: string;
    events: ReviewReplayEvent[];
  };
  messages: Array<{
    role: string;
    content: string | null;
    tool_calls?: Array<{ id: string; name: string; input: Record<string, unknown> }>;
    tool_results?: Array<{ tool_call_id: string; name: string; output: string; is_error: boolean }>;
  }>;
  // All stored messages including rewound ones, for review display
  raw_messages?: Array<{
    id: number;
    turn_sequence: number | null;
    role: string;
    content: string;
    created_at: number;
    rewound_at: number | null;
  }>;
  prompt?: ReviewPromptSummary | null;
  workspace_snapshot?: {
    active_path?: string;
    filesystem: Array<{ path: string; encoding: 'utf-8' | 'base64'; content: string }>;
  } | null;
}
```

- [ ] **Step 2: Update `/api/review/:id` to fetch and include raw messages**

In `packages/backend/src/routes/api.ts`, find the `GET /api/review/:id` handler (around line 2100). Change the `getBranchMessages` call to include rewound messages and add to response:

Replace:
```ts
const storedMessages = await db.getBranchMessages(sessionId, branch.id, conversation.id);
const messages = buildHistory(storedMessages);
```

With:
```ts
const allStoredMessages = await db.getBranchMessages(sessionId, branch.id, conversation.id, { includeRewound: true });
const storedMessages = allStoredMessages.filter((m) => m.rewound_at === null);
const messages = buildHistory(storedMessages);
const rawMessages = allStoredMessages.map((m) => ({
  id: m.id,
  turn_sequence: m.turn_sequence,
  role: m.role,
  content: m.content,
  created_at: m.created_at,
  rewound_at: m.rewound_at,
}));
```

And add `raw_messages: rawMessages` to the `res.json(...)` call:

```ts
res.json({
  session,
  messages,
  raw_messages: rawMessages,
  metrics,
  recording,
  prompt,
  branch,
  branches: await db.listBranches(sessionId),
  conversation,
  workspace_snapshot: workspaceSnapshot,
});
```

- [ ] **Step 3: Verify TypeScript compiles**

Run: `npm run typecheck`

Expected: no errors

- [ ] **Step 4: Commit**

```bash
git add packages/backend/src/routes/api.ts packages/frontend/src/lib/review-replay.ts
git commit -m "feat: include raw_messages with rewound_at in review API response"
```

---

## Task 7: Add `turnSequence` to `restoreFiles` and `handleRewind` to App.tsx

**Files:**
- Modify: `packages/frontend/src/lib/session-persist.ts`
- Modify: `packages/frontend/src/App.tsx`

- [ ] **Step 1: Add optional `turnSequence` to `restoreFiles`**

In `packages/frontend/src/lib/session-persist.ts`, update `restoreFiles` signature and URL construction:

```ts
export async function restoreFiles(
  sessionId: string,
  sessionToken: string,
  branchId?: string,
  apiBase = '',
  turnSequence?: number,
): Promise<RestoredWorkspaceState | null> {
  try {
    const params = new URLSearchParams();
    if (branchId) params.set('branch_id', branchId);
    if (turnSequence !== undefined) params.set('turn_sequence', String(turnSequence));
    const query = params.size > 0 ? `?${params.toString()}` : '';
    const workspaceRes = await fetch(`${apiBase}/api/sessions/${sessionId}/workspace${query}`, {
      headers: { Authorization: `Bearer ${sessionToken}` },
    });
    // ... rest of function body unchanged ...
```

Only the first 3 lines of the function body change (the URL construction). Everything after `if (workspaceRes.ok)` stays identical.

- [ ] **Step 2: Add `handleRewind` to `App.tsx`**

In `packages/frontend/src/App.tsx`, add `handleRewind` after `handleSaveCheckpoint` (around line 379):

```ts
const handleRewind = useCallback(async (turnSequence: number, mode: 'code' | 'both') => {
  if (!sessionId || !sessionToken || !activeBranchId) return;

  if (mode === 'both') {
    await fetch(`/api/sessions/${sessionId}/rewind`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${sessionToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ branch_id: activeBranchId, turn_sequence: turnSequence }),
    });
  }

  const restored = await restoreFiles(sessionId, sessionToken, activeBranchId, '', turnSequence);
  applyRestoredWorkspaceState(restored);
}, [activeBranchId, applyRestoredWorkspaceState, sessionId, sessionToken]);
```

- [ ] **Step 3: Pass `handleRewind` and `onRewind` to `ChatPanel`**

In `App.tsx`, find the `<ChatPanel ... />` JSX (around line 659). Add the prop:

```tsx
onRewind={handleRewind}
```

- [ ] **Step 4: Verify TypeScript compiles**

Run: `npm run typecheck --workspace=packages/frontend`

Expected: type error that `onRewind` doesn't exist on `ChatPanelProps` yet. That's OK — we'll fix in Task 8.

- [ ] **Step 5: Commit**

```bash
git add packages/frontend/src/lib/session-persist.ts packages/frontend/src/App.tsx
git commit -m "feat: add handleRewind to App.tsx and turnSequence param to restoreFiles"
```

---

## Task 8: Redesign context panel in ChatPanel

**Files:**
- Modify: `packages/frontend/src/components/ChatPanel.tsx`

This task only touches the context panel JSX — no logic changes. Do not change the rewind icon yet (Task 9).

- [ ] **Step 1: Remove `Clock3` import and update imports**

At the top of `ChatPanel.tsx`, in the lucide-react import, remove `Clock3` (it's only used in the conversation history section being removed). Verify `RotateCcw` is added:

```ts
import { 
  Send, 
  CornerDownLeft, 
  ChevronDown, 
  Square, 
  MessageSquare,
  AlertCircle,
  Bookmark,
  Check,
  X,
  Plus,
  RefreshCw,
  FileText,
  FolderTree,
  Layers3,
  RotateCcw,
} from 'lucide-react';
```

- [ ] **Step 2: Update the context panel header**

Find the context panel header (around line 1365). Replace:

```tsx
<div className="border-b border-white/8 px-4 py-3">
  <div className="flex items-center justify-between gap-3">
    <div>
      <div className="text-[12px] font-semibold" style={{ color: 'var(--color-text-main)' }}>
        Context tools
      </div>
      <div className="text-[11px] opacity-60" style={{ color: 'var(--color-text-dim)' }}>
        {Math.round(tokenUsagePct)}% of the window is in use
      </div>
    </div>
    <div className="text-[11px] opacity-60" style={{ color: 'var(--color-text-dim)' }}>
      {activeConversationId ? conversations.find((conversation) => conversation.id === activeConversationId)?.title ?? 'New chat' : 'Loading'}
    </div>
  </div>
</div>
```

With:

```tsx
<div className="border-b border-white/8 px-4 py-3">
  <div className="text-[13px] font-semibold" style={{ color: 'var(--color-text-main)' }}>
    Context
  </div>
  <div className="text-[11px] mt-0.5" style={{ color: 'var(--color-text-dim)' }}>
    {Math.round(tokenUsagePct)}% of window in use
  </div>
</div>
```

- [ ] **Step 3: Redesign the action buttons**

Find the `<div className="mb-4 flex flex-wrap gap-2">` block (around line 1382). Replace it entirely:

```tsx
<div className="mb-4 flex flex-wrap gap-2">
  <button
    type="button"
    onClick={() => void handleCreateConversation()}
    disabled={contextBusy || loading}
    className="inline-flex items-center gap-1.5 rounded-[var(--assessment-radius-control)] bg-white/10 px-3 py-1.5 text-[12px] font-medium transition hover:bg-white/15 disabled:opacity-40"
    style={{ color: 'var(--color-text-main)' }}
    data-testid="new-chat-button"
  >
    <Plus size={13} />
    New chat
  </button>
  <button
    type="button"
    onClick={() => void handleCreateConversation()}
    disabled={contextBusy || loading}
    className="inline-flex items-center gap-1.5 rounded-[var(--assessment-radius-control)] bg-white/6 px-3 py-1.5 text-[12px] font-medium transition hover:bg-white/10 disabled:opacity-40"
    style={{ color: 'var(--color-text-dim)' }}
    data-testid="clear-chat-button"
  >
    <X size={13} />
    Clear
  </button>
  <button
    type="button"
    onClick={() => void handleGenerateRepoMap()}
    disabled={contextBusy}
    className="inline-flex items-center gap-1.5 rounded-[var(--assessment-radius-control)] bg-white/6 px-3 py-1.5 text-[12px] font-medium transition hover:bg-white/10 disabled:opacity-40"
    style={{ color: 'var(--color-text-dim)' }}
    data-testid="generate-repo-map-button"
  >
    <FolderTree size={13} />
    Refresh repo map
  </button>
  <button
    type="button"
    onClick={() => void handleGenerateSummary()}
    disabled={contextBusy || !activeConversationId}
    className="inline-flex items-center gap-1.5 rounded-[var(--assessment-radius-control)] bg-white/6 px-3 py-1.5 text-[12px] font-medium transition hover:bg-white/10 disabled:opacity-40"
    style={{ color: 'var(--color-text-dim)' }}
    data-testid="generate-summary-button"
  >
    <RefreshCw size={13} className={contextBusy ? 'animate-spin' : ''} />
    Summarize chat
  </button>
</div>
```

- [ ] **Step 4: Remove the conversation history section**

Find and delete the entire conversation history `<div className="mb-4">` block (around lines 1429–1463), which contains:

```tsx
<div className="mb-4">
  <div className="mb-2 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.18em]" ...>
    <Clock3 size={11} />
    Conversation history
  </div>
  <div className="space-y-1">
    {conversations.map(...)}
  </div>
</div>
```

Delete all of that block.

- [ ] **Step 5: Update remaining section headers to lowercase**

Find all three remaining section headers (File context, Saved summaries, Prior chat snapshots). Each currently uses:
```tsx
className="mb-2 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.18em]"
```

Replace all three with:
```tsx
className="mb-2 flex items-center gap-2 text-[11px] font-medium"
```

The section labels themselves are already lowercase — no text change needed.

- [ ] **Step 6: Verify TypeScript compiles**

Run: `npm run typecheck --workspace=packages/frontend`

Expected: type error about `onRewind` prop (not added yet). Otherwise no errors.

- [ ] **Step 7: Commit**

```bash
git add packages/frontend/src/components/ChatPanel.tsx
git commit -m "feat: redesign context panel — remove conversation history, polish buttons and headers"
```

---

## Task 9: Add rewind icon and popover to user messages in ChatPanel

**Files:**
- Modify: `packages/frontend/src/components/ChatPanel.tsx`

- [ ] **Step 1: Add `onRewind` prop and `rewindPopoverFor` state**

Find the `ChatPanelProps` interface (around line 153). Add after `onTurnComplete`:

```ts
onRewind?: (turnSequence: number, mode: 'code' | 'both') => Promise<void>;
```

Find the destructuring in the component function (around line 335). Add `onRewind` to the destructured props.

Add a new state variable after the other state declarations (around line 355):

```ts
const [rewindPopoverFor, setRewindPopoverFor] = useState<string | null>(null);
```

- [ ] **Step 2: Add click-outside handler for rewind popover**

In the existing `useEffect` that handles closing the context panel on outside click (search for `contextPanelRef`), add the rewind popover dismissal. If the click target is not inside an element with `data-rewind-popover`, close the popover:

```ts
useEffect(() => {
  function handleOutside(e: MouseEvent) {
    if (
      contextPanelRef.current &&
      !contextPanelRef.current.contains(e.target as Node)
    ) {
      setContextPanelOpen(false);
    }
    const target = e.target as Element;
    if (!target.closest('[data-rewind-popover]')) {
      setRewindPopoverFor(null);
    }
  }
  document.addEventListener('mousedown', handleOutside);
  return () => document.removeEventListener('mousedown', handleOutside);
}, []);
```

(If there's already a `useEffect` with a similar pattern, merge into it.)

- [ ] **Step 3: Update the user message render to include rewind icon**

Find the user message render block (around line 995):

```tsx
if (isUser) {
  const msg = group.messages[0]!;
  return (
    <div key={msg.id} className="flex flex-col py-1">
      <div
        className="w-full rounded-[var(--assessment-radius-shell)] px-6 py-4 text-[14px] whitespace-pre-wrap break-words border-none shadow-none"
        style={{ background: 'var(--color-bg-user-msg)', color: 'var(--color-text-user-msg)' }}
        data-testid="user-message"
      >
        {msg.content}
      </div>
    </div>
  );
}
```

Replace with:

```tsx
if (isUser) {
  const msg = group.messages[0]!;
  const canRewind = !!onRewind && typeof msg.turnSequence === 'number';
  const isRewindOpen = rewindPopoverFor === msg.id;

  return (
    <div key={msg.id} className="group/msg relative flex flex-col py-1">
      <div
        className="w-full rounded-[var(--assessment-radius-shell)] px-6 py-4 text-[14px] whitespace-pre-wrap break-words border-none shadow-none"
        style={{ background: 'var(--color-bg-user-msg)', color: 'var(--color-text-user-msg)' }}
        data-testid="user-message"
      >
        {msg.content}
      </div>
      {canRewind && (
        <div className="absolute top-3 right-3" data-rewind-popover>
          <button
            type="button"
            onClick={() => setRewindPopoverFor(isRewindOpen ? null : msg.id)}
            className="flex items-center justify-center rounded-full w-7 h-7 opacity-0 group-hover/msg:opacity-100 transition-opacity hover:bg-white/10"
            style={{ color: 'var(--color-text-dim)' }}
            title="Rewind to here"
            data-testid="rewind-button"
          >
            <RotateCcw size={13} />
          </button>
          {isRewindOpen && (
            <div
              className="absolute right-0 top-full mt-1 z-50 flex flex-col overflow-hidden rounded-[var(--assessment-radius-control)] border border-white/10 shadow-2xl"
              style={{ background: 'rgba(19,19,20,0.98)', backdropFilter: 'blur(10px)', minWidth: '180px' }}
            >
              <button
                type="button"
                onClick={() => {
                  setRewindPopoverFor(null);
                  const ts = msg.turnSequence as number;
                  setMessages((prev) => prev.filter((m) => {
                    if (m.role === 'user' && m.turnSequence === ts) return true;
                    if (m.turnSequence === null || m.turnSequence === undefined) return true;
                    return m.turnSequence <= ts;
                  }));
                  setInput(msg.content);
                  void onRewind!(ts, 'both');
                }}
                className="px-4 py-2.5 text-left text-[12px] transition hover:bg-white/8"
                style={{ color: 'var(--color-text-main)' }}
              >
                Rewind code + conversation
              </button>
              <button
                type="button"
                onClick={() => {
                  setRewindPopoverFor(null);
                  void onRewind!(msg.turnSequence as number, 'code');
                }}
                className="px-4 py-2.5 text-left text-[12px] transition hover:bg-white/8 border-t border-white/8"
                style={{ color: 'var(--color-text-dim)' }}
              >
                Rewind code only
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
```

Note: `setInput` sets the textarea value — verify the state variable name in the component (search for `useState('')` near textarea — it may be `text` or `input`). Use whatever name the existing code uses. Similarly, `setMessages` is the setter for the `messages` state array.

- [ ] **Step 4: Verify TypeScript compiles**

Run: `npm run typecheck --workspace=packages/frontend`

Expected: no errors

- [ ] **Step 5: Run existing tests**

Run: `npm run test --workspace=packages/frontend 2>&1 | grep -E "PASS|FAIL"`

Expected: all PASS (no regressions)

- [ ] **Step 6: Commit**

```bash
git add packages/frontend/src/components/ChatPanel.tsx
git commit -m "feat: add hover rewind icon and popover to user messages in chat"
```

---

## Task 10: Add rewound blocks to ReviewDashboard

**Files:**
- Modify: `packages/frontend/src/components/ReviewDashboard.tsx`

- [ ] **Step 1: Add `RewindBlock` type and computation helper**

At the top of `ReviewDashboard.tsx`, after the existing type/interface imports, add:

```ts
interface RewindBlock {
  kind: 'rewindBlock';
  id: string;
  insertAfterTimestamp: number; // position in the conversation list
  messages: Array<{
    id: number;
    role: string;
    content: string;
    created_at: number;
  }>;
}

function computeRewindBlocks(
  rawMessages: NonNullable<ReviewDataPayload['raw_messages']>,
): RewindBlock[] {
  const blocks: RewindBlock[] = [];
  let currentBlock: RewindBlock | null = null;
  let lastNonRewoundTimestamp = 0;

  for (const msg of rawMessages) {
    if (msg.rewound_at !== null) {
      if (!currentBlock) {
        currentBlock = {
          kind: 'rewindBlock',
          id: `rewind-${msg.id}`,
          insertAfterTimestamp: lastNonRewoundTimestamp,
          messages: [],
        };
      }
      currentBlock.messages.push({
        id: msg.id,
        role: msg.role,
        content: msg.content,
        created_at: msg.created_at,
      });
    } else {
      if (currentBlock) {
        blocks.push(currentBlock);
        currentBlock = null;
      }
      lastNonRewoundTimestamp = msg.created_at;
    }
  }

  if (currentBlock) blocks.push(currentBlock);
  return blocks;
}
```

- [ ] **Step 2: Add `expandedRewindBlocks` state**

In the `ReviewDashboard` component function, after `const [showMetricDetails, setShowMetricDetails] = useState(false)`, add:

```ts
const [expandedRewindBlocks, setExpandedRewindBlocks] = useState<Set<string>>(new Set());
```

- [ ] **Step 3: Compute rewind blocks from data**

After the `conversationItems` useMemo (around line 494), add:

```ts
const rewindBlocks = useMemo(
  () => computeRewindBlocks(data?.raw_messages ?? []),
  [data],
);
```

- [ ] **Step 4: Render rewind blocks inline in conversation list**

Find the conversation panel render (around line 689):

```tsx
{conversationItems.map((item, itemIndex) => {
```

Replace with a version that interleaves rewind blocks. Add the rewind block rendering before the conversation items map, using timestamp comparison:

```tsx
{(() => {
  const rendered: React.ReactNode[] = [];

  conversationItems.forEach((item, itemIndex) => {
    // Check if any rewind blocks should be inserted before this item
    const itemTimestamp = item.kind === 'toolGroup'
      ? (events[item.eventIndex]?.timestamp ?? 0)
      : (events[item.entry.eventIndex]?.timestamp ?? 0);

    for (const block of rewindBlocks) {
      if (
        block.insertAfterTimestamp > 0 &&
        block.insertAfterTimestamp < itemTimestamp &&
        !rendered.some((n) => (n as React.ReactElement)?.key === block.id)
      ) {
        const isExpanded = expandedRewindBlocks.has(block.id);
        rendered.push(
          <div key={block.id} className="rounded-xl border border-white/8 overflow-hidden">
            <button
              type="button"
              onClick={() => setExpandedRewindBlocks((prev) => {
                const next = new Set(prev);
                if (next.has(block.id)) next.delete(block.id); else next.add(block.id);
                return next;
              })}
              className="flex w-full items-center justify-between px-4 py-2.5 text-left transition hover:bg-white/4"
              style={{ color: 'var(--color-text-dim)' }}
            >
              <div className="flex items-center gap-2 text-[11px] font-medium">
                <RotateCcw size={12} />
                Rewound here
                <span className="opacity-55">· {block.messages.length} {block.messages.length === 1 ? 'turn' : 'turns'} hidden</span>
              </div>
              <ChevronDown
                size={13}
                style={{ transform: isExpanded ? 'rotate(180deg)' : 'rotate(0deg)', transition: 'transform 160ms ease' }}
              />
            </button>
            {isExpanded && (
              <div className="border-t border-white/8 px-4 py-3 space-y-3">
                {block.messages.map((m) => (
                  <div key={m.id} className="text-[12px]" style={{ color: 'var(--color-text-dim)' }}>
                    <span className="font-medium mr-2" style={{ color: 'var(--color-text-dimmest)' }}>
                      {m.role === 'user' ? 'You' : 'Agent'}
                    </span>
                    <span className="opacity-70 whitespace-pre-wrap break-words line-clamp-3">
                      {m.content.slice(0, 200)}{m.content.length > 200 ? '…' : ''}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>,
        );
      }
    }

    const isPast = (item.kind === 'toolGroup' ? item.eventIndex : item.entry.eventIndex) <= selectedEventIndex;
    const isAnchor = itemIndex === anchorItemIndex;

    if (item.kind === 'toolGroup') {
      rendered.push(
        <div key={item.id} ref={(node) => { conversationRefs.current[itemIndex] = node; }}>
          <ToolGroup group={item} isPast={isPast} isAnchor={isAnchor} />
        </div>,
      );
      return;
    }

    const { entry } = item;
    const isUser = entry.title === 'You';

    if (!isUser) {
      rendered.push(
        <div key={entry.id} ref={(node) => { conversationRefs.current[itemIndex] = node; }}>
          <AgentMessage entry={entry} isPast={isPast} isAnchor={isAnchor} />
        </div>,
      );
      return;
    }

    rendered.push(
      <motion.div
        key={entry.id}
        ref={(node) => { conversationRefs.current[itemIndex] = node; }}
        initial={false}
        animate={{ opacity: isPast ? 1 : 0.2 }}
        className="rounded-xl p-4 text-[14px] leading-relaxed transition-all"
        style={{
          background: isAnchor ? 'rgba(56,135,206,0.12)' : 'var(--color-bg-user-msg)',
          color: 'var(--color-text-main)',
        }}
      >
        <div className="mb-2 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <User size={13} style={{ color: 'var(--color-brand)' }} />
            <span className="text-[12px] font-bold" style={{ color: 'var(--color-brand)' }}>
              Candidate
            </span>
          </div>
          <span className="font-mono text-[10px]" style={{ color: 'var(--color-text-dimmest)' }}>
            {formatTimestamp(entry.timestamp)}
          </span>
        </div>
        <div className="whitespace-pre-wrap break-words opacity-95">
          {entry.body || <span className="italic opacity-40">No text content</span>}
        </div>
      </motion.div>,
    );
  });

  return rendered;
})()}
```

Also add `RotateCcw` to the import from lucide-react at the top of the file (it likely already imports `ChevronDown`).

- [ ] **Step 5: Verify TypeScript compiles**

Run: `npm run typecheck --workspace=packages/frontend`

Expected: no errors

- [ ] **Step 6: Run all tests**

Run: `npm run test 2>&1 | grep -E "PASS|FAIL"`

Expected: all PASS

- [ ] **Step 7: Commit**

```bash
git add packages/frontend/src/components/ReviewDashboard.tsx
git commit -m "feat: show rewound message blocks in review dashboard conversation panel"
```

---

## Self-Review

**Spec coverage:**
- ✅ Rewind icon (hover, RotateCcw, top-right of user bubble) — Task 9
- ✅ Two options: "Rewind code + conversation" and "Rewind code only" — Task 9
- ✅ "Rewind code + conversation" — soft-hides messages server-side, removes from frontend, restores textarea — Tasks 5, 9
- ✅ Code snapshot restored — Task 7 (`restoreFiles` with `turnSequence`)
- ✅ Messages NOT deleted, just flagged with `rewound_at` — Task 1
- ✅ Context panel redesign: "Context" header, lowercase section headers, polished buttons — Task 8
- ✅ Conversation history removed from context panel — Task 8
- ✅ Review dashboard: rewound blocks inline, collapsible — Task 10
- ✅ Both SQLite and Postgres adapters — Tasks 2, 3
- ✅ Mock adapters updated — Task 4

**Type consistency check:**
- `onRewind?: (turnSequence: number, mode: 'code' | 'both') => Promise<void>` — used consistently in ChatPanel props (Task 9) and App.tsx (Task 7)
- `rewindMessages(sessionId, branchId, conversationId, afterTurnSequence)` — same signature in interface (Task 1), SQLiteAdapter (Task 2), PostgresAdapter (Task 3), endpoint call (Task 5)
- `getBranchMessages(..., options?: { includeRewound?: boolean })` — consistent across interface, both adapters, test mocks

**Placeholder scan:** None found.

**One edge case:** In Task 9, `setInput` — the actual state setter name for the textarea must be verified. Search for `const [input, setInput]` or `const [text, setText]` in ChatPanel.tsx and use whichever matches.
