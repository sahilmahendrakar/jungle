import { Tabs } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { useChatStore } from "../../src/store/chat";
import { useTheme } from "../../src/lib/theme-context";

// Bottom tabs (Slack-mobile IA): Home / Workflows / Activity / Search / You. The Activity tab
// badges the count of things waiting on you (pending approvals + unread threads).
export default function TabsLayout() {
  const { colors } = useTheme();
  const confirms = useChatStore((s) => s.confirms.length);
  const unreadThreads = useChatStore((s) => s.unreadThreads.length);
  const activityBadge = confirms + unreadThreads;

  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: colors.primary,
        tabBarInactiveTintColor: colors.mutedForeground,
        tabBarStyle: { backgroundColor: colors.card, borderTopColor: colors.border },
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: "Home",
          tabBarIcon: ({ color, size }) => <Ionicons name="home" color={color} size={size} />,
        }}
      />
      <Tabs.Screen
        name="workflows"
        options={{
          title: "Workflows",
          tabBarIcon: ({ color, size }) => <Ionicons name="git-network" color={color} size={size} />,
        }}
      />
      <Tabs.Screen
        name="activity"
        options={{
          title: "Activity",
          tabBarBadge: activityBadge > 0 ? activityBadge : undefined,
          tabBarIcon: ({ color, size }) => (
            <Ionicons name="notifications" color={color} size={size} />
          ),
        }}
      />
      <Tabs.Screen
        name="search"
        options={{
          title: "Search",
          tabBarIcon: ({ color, size }) => <Ionicons name="search" color={color} size={size} />,
        }}
      />
      <Tabs.Screen
        name="you"
        options={{
          title: "You",
          tabBarIcon: ({ color, size }) => (
            <Ionicons name="person-circle" color={color} size={size} />
          ),
        }}
      />
    </Tabs>
  );
}
