import { env } from "./env";

export function apiUrl() {
  return (env("API_URL") ?? "http://127.0.0.1:8790").replace(/\/$/, "");
}
