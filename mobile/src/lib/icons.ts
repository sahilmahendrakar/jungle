// Shared alias for the Ionicons glyph-name union, so maps of tool/deliverable → icon can be typed.
import type { Ionicons } from "@expo/vector-icons";

export type IoniconName = React.ComponentProps<typeof Ionicons>["name"];
