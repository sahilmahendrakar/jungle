import * as React from "react";
import { X } from "lucide-react";

import { cn } from "@/lib/utils";

/**
 * The one red banner used for user-facing errors. Always closeable: an error you can't dismiss
 * sticks around long after it stopped being true (the "agent limit" notice used to sit above the
 * composer until you sent a message), so `onDismiss` is required.
 */
function ErrorBanner({
  onDismiss,
  size = "sm",
  className,
  children,
  ...props
}: Omit<React.ComponentProps<"div">, "role"> & {
  onDismiss: () => void;
  size?: "sm" | "xs";
}) {
  return (
    <div
      data-slot="error-banner"
      role="alert"
      className={cn(
        "flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/10 py-1.5 pl-3 pr-1.5 text-destructive",
        size === "xs" ? "text-xs" : "text-sm",
        className,
      )}
      {...props}
    >
      <div className="min-w-0 flex-1 self-center break-words">{children}</div>
      <button
        type="button"
        aria-label="Dismiss"
        onClick={onDismiss}
        className="-mr-0.5 shrink-0 rounded-sm p-1 opacity-70 transition-opacity hover:opacity-100 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-destructive/30"
      >
        <X className={size === "xs" ? "size-3" : "size-3.5"} />
      </button>
    </div>
  );
}

export { ErrorBanner };
