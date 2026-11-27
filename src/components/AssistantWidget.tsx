import {
  ActionBarPrimitive,
  AssistantModalPrimitive,
  AssistantRuntimeProvider,
  ComposerPrimitive,
  MessagePrimitive,
  ThreadPrimitive,
  useLocalRuntime,
  type ChatModelAdapter,
  type ThreadMessageLike,
} from "@assistant-ui/react";
import { useCallback, useEffect, useMemo, useState } from "react";
import ReactMarkdown from "react-markdown";

interface ThreadSummary {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
  message_count: number;
}

interface StoredMessage {
  id: string;
  thread_id: string;
  role: "user" | "assistant" | "system";
  content: string;
  created_at: string;
}

function makeClientThreadId() {
  return `thr_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function toThreadMessages(rows: StoredMessage[]): ThreadMessageLike[] {
  return rows.map((m) => ({
    id: m.id,
    role: m.role,
    content: [{ type: "text", text: m.content }],
    createdAt: m.created_at ? new Date(m.created_at) : undefined,
  }));
}

function createChatAdapter(
  threadId: string,
  onThreadUpdated: () => void
): ChatModelAdapter {
  return {
    async *run({ messages, abortSignal }) {
      const simplified = messages.map((m) => ({
        role: m.role,
        content: m.content
          .filter((p): p is { type: "text"; text: string } => p.type === "text")
          .map((p) => p.text)
          .join("\n"),
      }));

      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ threadId, messages: simplified }),
        signal: abortSignal,
      });

      if (!res.ok || !res.body) {
        const errObj = await res.json().catch(() => ({}));
        throw new Error(errObj.error || `HTTP ${res.status}`);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let reasoning = "";
      let text = "";
      let sources: { title: string; url: string }[] = [];

      const buildContent = () => {
        const parts: (
          | { type: "reasoning"; text: string }
          | { type: "text"; text: string }
        )[] = [];
        if (reasoning) parts.push({ type: "reasoning", text: reasoning });
        if (text) parts.push({ type: "text", text });
        return parts;
      };

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split(/\r?\n/);
          buffer = lines.pop() || "";

          for (const line of lines) {
            if (!line.startsWith("data:")) continue;
            const payload = line.slice(5).trim();
            if (!payload || payload === "[DONE]") continue;
            const evt = JSON.parse(payload);
            if (evt.error) throw new Error(evt.error);
            if (evt.reasoning) {
              reasoning += evt.reasoning;
              yield { content: buildContent() };
            }
            if (evt.delta) {
              text += evt.delta;
              yield { content: buildContent() };
            }
            if (Array.isArray(evt.sources)) {
              sources = evt.sources;
            }
          }
        }
        if (sources.length > 0) {
          const footer =
            "\n\n---\n" +
            sources.map((s) => `[${s.title} ↗](${s.url})`).join(" · ");
          text += footer;
          yield { content: buildContent() };
        }
      } finally {
        reader.releaseLock();
        onThreadUpdated();
      }
    },
  };
}

function MarkdownText({ text }: { text: string }) {
  return (
    <div className="aui-md">
      <ReactMarkdown
        components={{
          a: ({ href, children }) => (
            <a href={href} target="_blank" rel="noreferrer">
              {children}
            </a>
          ),
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}

function UserMessage() {
  return (
    <MessagePrimitive.Root className="aui-msg aui-msg-user">
      <MessagePrimitive.Parts />
    </MessagePrimitive.Root>
  );
}

function ReasoningText({
  text,
  status,
}: {
  text: string;
  status: { type: string };
}) {
  const isStreaming = status.type === "running";
  const [open, setOpen] = useState(isStreaming);

  useEffect(() => {
    setOpen(isStreaming);
  }, [isStreaming]);

  return (
    <div className={`aui-reasoning ${isStreaming ? "is-streaming" : ""}`}>
      <button
        type="button"
        className="aui-reasoning-trigger"
        aria-expanded={open}
        onClick={() => setOpen((prev) => !prev)}
      >
        <svg
          className="aui-reasoning-brain"
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M12 2a7 7 0 0 0-7 7c0 2.5 1.3 4.7 3.3 5.9L9 17h6l.7-2.1A7 7 0 0 0 12 2z" />
          <path d="M9 21h6" />
        </svg>
        <span className={isStreaming ? "aui-reasoning-shimmer" : ""}>
          {isStreaming ? "Sedang berpikir..." : "Proses berpikir"}
        </span>
        <svg
          className={`aui-reasoning-chevron ${open ? "is-open" : ""}`}
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="m6 9 6 6 6-6" />
        </svg>
      </button>

      {open && (
        <div className="aui-reasoning-body">
          <ReactMarkdown>{text}</ReactMarkdown>
        </div>
      )}
    </div>
  );
}

function AssistantMessage() {
  return (
    <MessagePrimitive.Root className="aui-msg aui-msg-assistant">
      <MessagePrimitive.Parts
        components={{
          Reasoning: ReasoningText,
          Text: MarkdownText,
        }}
      />
      <ActionBarPrimitive.Root
        className="aui-actions"
        hideWhenRunning
        autohide="not-last"
      >
        <ActionBarPrimitive.Copy className="aui-action-btn">
          Salin
        </ActionBarPrimitive.Copy>
        <ActionBarPrimitive.Reload className="aui-action-btn">
          Ulangi
        </ActionBarPrimitive.Reload>
      </ActionBarPrimitive.Root>
    </MessagePrimitive.Root>
  );
}

function ThreadSession({
  threadId,
  initialMessages,
  onThreadUpdated,
}: {
  threadId: string;
  initialMessages: ThreadMessageLike[];
  onThreadUpdated: () => void;
}) {
  const adapter = useMemo(
    () => createChatAdapter(threadId, onThreadUpdated),
    [threadId, onThreadUpdated]
  );
  const runtime = useLocalRuntime(adapter, { initialMessages });

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <ThreadPrimitive.Root className="aui-thread">
        <ThreadPrimitive.Viewport className="aui-viewport">
          <ThreadPrimitive.Empty>
            <div className="aui-empty">
              <p className="meta">
                Pilih pertanyaan cepat atau ketik langsung di bawah.
              </p>
              <div className="prompt-starters">
                <ThreadPrimitive.Suggestion
                  className="starter-chip"
                  prompt="Ringkas kondisi teknikal 4 aset (Gold, USDJPY, GBPUSD, US Oil) saat ini dalam 4 poin singkat siap dibacakan: bias tren, RSI, dan level S1/R1 terdekat."
                  method="replace"
                  autoSend
                >
                  &ldquo;Ringkas kondisi 4 aset sekarang&rdquo;
                </ThreadPrimitive.Suggestion>
                <ThreadPrimitive.Suggestion
                  className="starter-chip"
                  prompt="Fokus ke Gold (XAUUSD): kondisi 15m/1H/4H gimana, ada berita katalis hari ini apa, dan level kunci terdekat berapa?"
                  method="replace"
                  autoSend
                >
                  &ldquo;Gold aman buy atau tunggu?&rdquo;
                </ThreadPrimitive.Suggestion>
                <ThreadPrimitive.Suggestion
                  className="starter-chip"
                  prompt="Fokus ke US Oil (USOIL): kondisi tren, berita hari ini, dan level penting berapa?"
                  method="replace"
                  autoSend
                >
                  &ldquo;Level penting US Oil hari ini?&rdquo;
                </ThreadPrimitive.Suggestion>
              </div>
            </div>
          </ThreadPrimitive.Empty>

          <ThreadPrimitive.Messages
            components={{
              UserMessage,
              AssistantMessage,
            }}
          />
        </ThreadPrimitive.Viewport>

        <ComposerPrimitive.Root className="aui-composer">
          <ComposerPrimitive.Input
            className="aui-input"
            placeholder="Tanya soal Gold, Oil, FX..."
            rows={1}
            autoFocus={false}
          />
          <ComposerPrimitive.Send className="btn btn-primary aui-send">
            Tanya
          </ComposerPrimitive.Send>
          <ComposerPrimitive.Cancel className="btn aui-send">
            Stop
          </ComposerPrimitive.Cancel>
        </ComposerPrimitive.Root>
      </ThreadPrimitive.Root>
    </AssistantRuntimeProvider>
  );
}

export function AssistantWidget() {
  const [threads, setThreads] = useState<ThreadSummary[]>([]);
  const [activeThreadId, setActiveThreadId] = useState<string>(() =>
    makeClientThreadId()
  );
  const [initialMessages, setInitialMessages] = useState<ThreadMessageLike[]>(
    []
  );
  const [sessionVersion, setSessionVersion] = useState(0);
  const [loadingThread, setLoadingThread] = useState(false);

  const refreshThreads = useCallback(async () => {
    try {
      const res = await fetch("/api/threads");
      if (!res.ok) return [];
      const data = await res.json();
      const list: ThreadSummary[] = Array.isArray(data.threads)
        ? data.threads
        : [];
      setThreads(list);
      return list;
    } catch {
      return [];
    }
  }, []);

  const loadThread = useCallback(async (threadId: string) => {
    setLoadingThread(true);
    try {
      const res = await fetch(
        `/api/threads/${encodeURIComponent(threadId)}/messages`
      );
      if (!res.ok) return;
      const data = await res.json();
      const rows: StoredMessage[] = Array.isArray(data.messages)
        ? data.messages
        : [];
      setActiveThreadId(threadId);
      setInitialMessages(toThreadMessages(rows));
      setSessionVersion((v) => v + 1);
    } finally {
      setLoadingThread(false);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const list = await refreshThreads();
      if (!cancelled && list.length > 0) {
        await loadThread(list[0].id);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [refreshThreads, loadThread]);

  const handleNewThread = () => {
    setActiveThreadId(makeClientThreadId());
    setInitialMessages([]);
    setSessionVersion((v) => v + 1);
  };

  const handleDeleteThread = async () => {
    const isSaved = threads.some((t) => t.id === activeThreadId);
    if (!isSaved) return;
    await fetch(`/api/threads/${encodeURIComponent(activeThreadId)}`, {
      method: "DELETE",
    }).catch(() => {});
    const remaining = await refreshThreads();
    if (remaining.length > 0) {
      await loadThread(remaining[0].id);
    } else {
      handleNewThread();
    }
  };

  const isSavedThread = threads.some((t) => t.id === activeThreadId);

  return (
    <AssistantModalPrimitive.Root>
      <AssistantModalPrimitive.Anchor className="aui-anchor">
        <AssistantModalPrimitive.Trigger
          className="aui-fab"
          aria-label="Buka asisten analisis"
        >
          <svg
            width="22"
            height="22"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
          </svg>
          <span className="aui-fab-label">Tanya</span>
        </AssistantModalPrimitive.Trigger>
      </AssistantModalPrimitive.Anchor>

      <AssistantModalPrimitive.Content
        side="top"
        align="end"
        sideOffset={12}
        className="aui-modal"
      >
        <div className="aui-modal-head">
          <span className="aui-modal-title">Tanya analisis</span>
          <AssistantModalPrimitive.Trigger
            className="aui-close-btn"
            aria-label="Tutup asisten"
          >
            Tutup
          </AssistantModalPrimitive.Trigger>
        </div>

        <div className="aui-thread-bar">
          <select
            className="aui-thread-select"
            aria-label="Pilih riwayat percakapan"
            value={isSavedThread ? activeThreadId : "__new__"}
            disabled={loadingThread}
            onChange={(e) => {
              const val = e.target.value;
              if (val === "__new__") {
                handleNewThread();
              } else {
                void loadThread(val);
              }
            }}
          >
            {!isSavedThread && (
              <option value="__new__">Percakapan baru</option>
            )}
            {threads.map((t) => (
              <option key={t.id} value={t.id}>
                {t.title} ({t.message_count})
              </option>
            ))}
          </select>

          <button
            type="button"
            className="aui-bar-btn"
            onClick={handleNewThread}
            disabled={loadingThread}
          >
            + Baru
          </button>

          {isSavedThread && (
            <button
              type="button"
              className="aui-bar-btn aui-bar-btn-danger"
              onClick={() => void handleDeleteThread()}
              disabled={loadingThread}
            >
              Hapus
            </button>
          )}
        </div>

        <ThreadSession
          key={`${activeThreadId}:${sessionVersion}`}
          threadId={activeThreadId}
          initialMessages={initialMessages}
          onThreadUpdated={() => {
            void refreshThreads();
          }}
        />
      </AssistantModalPrimitive.Content>
    </AssistantModalPrimitive.Root>
  );
}
