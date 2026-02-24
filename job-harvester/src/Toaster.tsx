import { useEffect } from "react";

export function Toaster({
  toast,
  onDismiss,
}: {
  toast: { title: string; description?: string } | null;
  onDismiss: () => void;
}) {
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(onDismiss, 5000);
    return () => clearTimeout(t);
  }, [toast, onDismiss]);

  if (!toast) return null;

  return (
    <div className="fixed bottom-6 right-6 z-50 max-w-sm rounded-lg border border-zinc-700 bg-zinc-900 px-4 py-3 shadow-xl">
      <p className="font-medium text-zinc-200">{toast.title}</p>
      {toast.description && (
        <p className="mt-1 text-sm text-zinc-500">{toast.description}</p>
      )}
      <button
        onClick={onDismiss}
        className="mt-2 text-xs text-zinc-500 hover:text-zinc-300"
      >
        Dismiss
      </button>
    </div>
  );
}
