import { getUser, isAdmin } from "./data/users.ts";

export function ownerIsAdmin(userId: string): boolean {
  return isAdmin(getUser(userId));
}
