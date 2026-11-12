export const sleep = (milliseconds: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, milliseconds));

export function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
