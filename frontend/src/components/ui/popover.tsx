import * as React from "react";
import * as PopoverPrimitive from "@radix-ui/react-popover";

import { cn } from "@/lib/utils";

function Popover(props: React.ComponentProps<typeof PopoverPrimitive.Root>) {
  return <PopoverPrimitive.Root data-slot="popover" {...props} />;
}

function PopoverTrigger(props: React.ComponentProps<typeof PopoverPrimitive.Trigger>) {
  return <PopoverPrimitive.Trigger data-slot="popover-trigger" {...props} />;
}

function PopoverContent({
  className,
  align = "start",
  sideOffset = 4,
  portal = true,
  ...props
}: React.ComponentProps<typeof PopoverPrimitive.Content> & { portal?: boolean }) {
  const content = (
    <PopoverPrimitive.Content
      data-slot="popover-content"
      align={align}
      sideOffset={sideOffset}
      className={cn(
        "z-50 w-72 rounded-md border bg-popover p-1 text-popover-foreground shadow-md outline-none",
        "animate-in fade-in-0 zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95",
        className,
      )}
      {...props}
    />
  );
  // Inside a Dialog, skip the portal so selecting an item counts as a click *inside* the
  // dialog — otherwise the dialog treats it as an outside interaction and dismisses itself.
  return portal ? <PopoverPrimitive.Portal>{content}</PopoverPrimitive.Portal> : content;
}

export { Popover, PopoverTrigger, PopoverContent };
