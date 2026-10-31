/** How deep bots may wake each other before a chain stops. */
export const MAX_CHAIN = 4;

/** A handoff's result lands a hop up from its brief. */
export function resultDepth(briefDepth: number): number {
  return Math.max(0, briefDepth - 1);
}

/** How many bot lines in a row a room takes before it waits for the person. */
export const MAX_ROOM_LINES = 20;
