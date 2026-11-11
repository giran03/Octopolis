import { beforeEach, describe, expect, it, vi } from "vitest";

let calls = 0;
let nextUrl = 1;
const revoked: string[] = [];

vi.mock("../lib/ipc", () => ({
  thumbnail: vi.fn(async () => {
    calls++;
    return new ArrayBuffer(8);
  }),
}));

vi.spyOn(URL, "createObjectURL").mockImplementation(() => `blob:thumb-${nextUrl++}`);
vi.spyOn(URL, "revokeObjectURL").mockImplementation((u: string) => {
  revoked.push(u);
});

const { clearThumbCache, loadCachedThumb, peekThumb, thumbCacheKey } = await import("../state/thumbs");

beforeEach(() => {
  clearThumbCache();
  calls = 0;
  nextUrl = 1;
  revoked.length = 0;
});

describe("video thumbnail cache", () => {
  it("deduplicates concurrent loads and serves hits synchronously", async () => {
    const [a, b] = await Promise.all([loadCachedThumb("X:\\clip.mp4", 100), loadCachedThumb("x:\\clip.mp4", 100)]);
    expect(a).toBe("blob:thumb-1");
    expect(b).toBe("blob:thumb-1");
    expect(calls).toBe(1);

    expect(peekThumb(thumbCacheKey("X:\\CLIP.MP4", 100))).toBe("blob:thumb-1");
    const c = await loadCachedThumb("X:\\clip.mp4", 100);
    expect(c).toBe("blob:thumb-1");
    expect(calls).toBe(1);
  });

  it("evicts oldest thumbnails and revokes object URLs past the cap", async () => {
    for (let i = 0; i < 165; i++) {
      await loadCachedThumb(`X:\\v${i}.mp4`, 1);
    }
    expect(revoked).toHaveLength(5);
    expect(peekThumb(thumbCacheKey("X:\\v0.mp4", 1))).toBeUndefined();
    expect(peekThumb(thumbCacheKey("X:\\v164.mp4", 1))).toBe("blob:thumb-165");
  });
});
