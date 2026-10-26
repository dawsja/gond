import { ChatsScreen } from "@/components/chats-screen";
import { EmptyState } from "@/components/empty-state";

export default function AppHome() {
  return (
    <>
      <ChatsScreen className="wide:hidden" />
      <EmptyState className="hidden wide:flex" />
    </>
  );
}
