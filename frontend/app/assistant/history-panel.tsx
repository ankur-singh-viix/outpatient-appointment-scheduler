'use client';

import { HistoryIcon, PlusIcon, Trash2Icon } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { Alert } from '@/components/common';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { api, errorMessage } from '@/lib/api';
import { appendPage, relativeDate } from '@/lib/assistant-history';
import type { ConversationSummary, Session } from '@/lib/types';
import { cn } from '@/lib/utils';

const PAGE = 20;

interface Page {
  conversations: ConversationSummary[];
  nextCursor: string | null;
}

/**
 * The person's earlier conversations with the assistant: a list beside the chat on wide screens, a drawer on narrow ones. Opening one
 * hands its id to the chat, which loads the saved messages; deleting one asks first. This list only ever shows what the server returns
 * for the signed-in person, and holds no messages itself.
 *
 * `version` changes whenever the chat saved an exchange, so the list refreshes without the chat reaching into it.
 */
export function HistoryPanel({
  session,
  activeId,
  version,
  disabled,
  onOpen,
  onNew,
  onDeleted,
}: {
  session: Session;
  activeId: string | null;
  version: number;
  /** True while a message is being answered or voice mode is on: switching conversations then would mix them up. */
  disabled: boolean;
  onOpen: (id: string) => void;
  onNew: () => void;
  onDeleted: (id: string) => void;
}) {
  const [items, setItems] = useState<ConversationSummary[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [drawer, setDrawer] = useState(false);
  const [doomed, setDoomed] = useState<ConversationSummary | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const fetchPage = useCallback(
    (cursor?: string) => api<Page>(`/assistant/conversations?limit=${PAGE}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`, { token: session.accessToken }),
    [session.accessToken],
  );

  // The first page, and again whenever the chat saved an exchange. State is only set once the answer arrives, and a slow older answer is ignored.
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let current = true;
    fetchPage().then(
      (page) => {
        if (!current) return;
        setItems(page.conversations);
        setNext(page.nextCursor);
        setError(null);
        setLoading(false);
      },
      (err) => {
        if (!current) return;
        setError(errorMessage(err));
        setLoading(false);
      },
    );
    return () => {
      current = false;
    };
  }, [fetchPage, version, retry]);

  const showOlder = async () => {
    if (!next) return;
    setLoading(true);
    try {
      const page = await fetchPage(next);
      setItems((current) => appendPage(current, page.conversations));
      setNext(page.nextCursor);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  };

  const confirmDelete = async () => {
    if (!doomed) return;
    setDeleting(true);
    setDeleteError(null);
    try {
      await api(`/assistant/conversations/${doomed.id}`, { method: 'DELETE', token: session.accessToken });
      setItems((current) => current.filter((entry) => entry.id !== doomed.id));
      onDeleted(doomed.id);
      setDoomed(null);
    } catch (err) {
      setDeleteError(errorMessage(err));
    } finally {
      setDeleting(false);
    }
  };

  const list = (
    <div className="space-y-3" aria-label="Chat history">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-sm font-semibold text-foreground">Chat history</h2>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={disabled}
          onClick={() => {
            onNew();
            setDrawer(false);
          }}
        >
          <PlusIcon aria-hidden /> New chat
        </Button>
      </div>

      {error && (
        <Alert
          action={
            <Button type="button" size="sm" variant="outline" onClick={() => (setLoading(true), setRetry((count) => count + 1))}>
              Retry
            </Button>
          }
        >
          History is not available right now. {error}
        </Alert>
      )}
      {!error && !loading && items.length === 0 && <p className="text-sm text-muted-foreground">No earlier chats yet. Your conversations will appear here.</p>}

      <ul className="space-y-1">
        {items.map((entry) => (
          <li key={entry.id} className={cn('group flex items-center gap-1 rounded-lg', entry.id === activeId && 'bg-accent')}>
            <button
              type="button"
              disabled={disabled}
              aria-current={entry.id === activeId ? 'true' : undefined}
              onClick={() => {
                onOpen(entry.id);
                setDrawer(false);
              }}
              className="min-w-0 flex-1 rounded-lg px-3 py-2 text-left outline-none hover:bg-accent focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-60"
            >
              <span className="block truncate text-sm font-medium text-foreground">{entry.title}</span>
              <span className="block text-xs text-muted-foreground">{relativeDate(entry.updatedAt)}</span>
            </button>
            <Button type="button" variant="ghost" size="icon-sm" aria-label={`Delete chat: ${entry.title}`} disabled={disabled} onClick={() => (setDeleteError(null), setDoomed(entry))}>
              <Trash2Icon aria-hidden />
            </Button>
          </li>
        ))}
      </ul>

      {loading && <p className="text-sm text-muted-foreground" role="status">Loading…</p>}
      {next && !loading && (
        <Button type="button" size="sm" variant="outline" onClick={() => void showOlder()}>
          Show older chats
        </Button>
      )}
    </div>
  );

  return (
    <>
      <div className="lg:hidden">
        <Button type="button" size="sm" variant="outline" onClick={() => setDrawer(true)}>
          <HistoryIcon aria-hidden /> Chat history
        </Button>
      </div>
      <aside className="hidden max-h-[70dvh] overflow-y-auto rounded-xl border bg-card p-3 lg:block">{list}</aside>

      <Dialog open={drawer} onOpenChange={setDrawer}>
        <DialogContent className="top-0 left-0 h-dvh max-h-dvh w-80 max-w-[85vw] translate-x-0 translate-y-0 rounded-none rounded-r-2xl p-4">
          <DialogTitle className="sr-only">Chat history</DialogTitle>
          {list}
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={doomed !== null}
        title="Delete this chat?"
        description={doomed ? `“${doomed.title}” and its messages will be deleted for good. This cannot be undone.` : ''}
        confirmLabel="Delete chat"
        cancelLabel="Keep it"
        busy={deleting}
        error={deleteError}
        onConfirm={() => void confirmDelete()}
        onClose={() => setDoomed(null)}
      />
    </>
  );
}
