import { cn } from "@/lib/utils";

// Loading placeholder block (shadcn skeleton): a pulsing rounded rectangle sized by the caller.
function Skeleton({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="skeleton"
      className={cn("animate-pulse rounded-md bg-muted", className)}
      {...props}
    />
  );
}

export { Skeleton };
