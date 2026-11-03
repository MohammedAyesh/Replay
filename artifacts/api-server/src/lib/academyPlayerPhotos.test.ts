import { describe, expect, it } from "vitest";
import { createCanvas } from "@napi-rs/canvas";
import { matchShootFiles, shirtNumberFromFileName } from "@workspace/api-zod";
import { pickPlayerPicture, processPlayerPhoto, transparentShare } from "./academyPlayerPhotos";

describe("photoshoot file names", () => {
  it("reads the shirt number from the usual ways a shoot is named", () => {
    expect(shirtNumberFromFileName("7.png")).toBe(7);
    expect(shirtNumberFromFileName("07-omar.png")).toBe(7);
    expect(shirtNumberFromFileName("#10.png")).toBe(10);
    expect(shirtNumberFromFileName("No 9 - Laith.webp")).toBe(9);
    expect(shirtNumberFromFileName("player_11.PNG")).toBe(11);
    expect(shirtNumberFromFileName("shoot/2026/04.png")).toBe(4);
    expect(shirtNumberFromFileName("00.png")).toBe(0);
    expect(shirtNumberFromFileName("omar.png")).toBeNull();
    expect(shirtNumberFromFileName("IMG_2034.png")).toBeNull();
    expect(shirtNumberFromFileName("100.png")).toBeNull();
  });

  it("matches each file to one active player, leaving unknown and shared numbers for the review", () => {
    const players = [
      { id: 1, jerseyNumber: 7, isActive: true },
      { id: 2, jerseyNumber: 10, isActive: true },
      { id: 3, jerseyNumber: 10, isActive: true },
      { id: 4, jerseyNumber: 9, isActive: false },
    ];
    expect(matchShootFiles(["7.png", "10.png", "9.png", "x.png", "11.png"], players).map((m) => [m.playerId, m.reason])).toEqual([
      [1, "matched"], [null, "ambiguous"], [null, "no-player"], [null, "no-number"], [null, "no-player"],
    ]);
  });
});

describe("processing a player photo", () => {
  it("detects a cut-out and keeps it as PNG; an opaque picture becomes WebP", async () => {
    const cut = createCanvas(300, 400);
    cut.getContext("2d").fillRect(100, 100, 100, 300);
    const a = await processPlayerPhoto(cut.toBuffer("image/png"));
    expect(a).toMatchObject({ transparent: true, mime: "image/png", width: 300, height: 400 });

    const full = createCanvas(300, 400);
    const g = full.getContext("2d");
    g.fillStyle = "#123456"; g.fillRect(0, 0, 300, 400);
    const b = await processPlayerPhoto(full.toBuffer("image/png"));
    expect(b).toMatchObject({ transparent: false, mime: "image/webp" });
    expect(b.bytes.subarray(8, 12).toString("ascii")).toBe("WEBP");
  });

  it("scales the longest side down to 1600 and refuses tiny or unreadable files", async () => {
    const big = createCanvas(1000, 3000);
    big.getContext("2d").fillRect(0, 0, 1000, 3000);
    expect(await processPlayerPhoto(big.toBuffer("image/png"))).toMatchObject({ width: 533, height: 1600 });
    await expect(processPlayerPhoto(createCanvas(20, 20).toBuffer("image/png"))).rejects.toThrow(/too small/);
    await expect(processPlayerPhoto(Buffer.from("nope"))).rejects.toThrow(/picture/);
  });

  it("counts a few soft corners as opaque", () => {
    const px = new Uint8ClampedArray(100 * 100 * 4).fill(255);
    for (let i = 0; i < 100; i += 1) px[i * 4 + 3] = 0; // one row of 100 transparent pixels (1%)
    expect(transparentShare(px, 100, 100)).toBeCloseTo(0.01, 2);
  });
});

describe("which picture stands for a player", () => {
  const photo = (id: number, isPrimary: boolean, at: number) => ({ id, isPrimary, createdAt: new Date(at) }) as never;
  it("the academy's main photo first, then its newest photo, then the account's avatar, then nothing", () => {
    expect(pickPlayerPicture([photo(1, false, 1), photo(2, true, 0)], { userId: 5, avatarPath: "avatars/u5-x.jpg" })).toMatchObject({ kind: "photo", photo: { id: 2 } });
    expect(pickPlayerPicture([photo(1, false, 1), photo(3, false, 9)], null)).toMatchObject({ kind: "photo", photo: { id: 3 } });
    expect(pickPlayerPicture([], { userId: 5, avatarPath: "avatars/u5-x.jpg" })).toEqual({ kind: "avatar", userId: 5, avatarPath: "avatars/u5-x.jpg" });
    expect(pickPlayerPicture([], { userId: null, avatarPath: null })).toBeNull();
  });
});
