import { describe, expect, it } from "vitest";
import { parseLocation } from "./chat-location";

describe("parseLocation", () => {
  it("reads coordinates typed or pasted from Google Maps", () => {
    expect(parseLocation("31.9539, 35.9106")).toEqual({ latitude: 31.9539, longitude: 35.9106 });
    expect(parseLocation("https://www.google.com/maps/place/Galaxy/@31.9539,35.9106,17z")).toEqual({ latitude: 31.9539, longitude: 35.9106 });
    expect(parseLocation("https://maps.google.com/?q=31.95,35.91")).toEqual({ latitude: 31.95, longitude: 35.91 });
    expect(parseLocation("https://www.google.com/maps/place/X/data=!3m1!4b1!4m6!3m5!1s0x0:0x0!8m2!3d31.9539!4d35.9106")).toEqual({ latitude: 31.9539, longitude: 35.9106 });
  });

  it("refuses text without coordinates", () => {
    expect(parseLocation("Galaxy pitch, Amman")).toBeNull();
    expect(parseLocation("https://maps.app.goo.gl/abc123")).toBeNull();
    expect(parseLocation("95.1, 35.9")).toBeNull();
  });
});
