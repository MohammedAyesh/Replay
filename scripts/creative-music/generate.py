#!/usr/bin/env python3
"""
Replay's own music library for the Creative hub, made from nothing but code.

Every sound here is synthesised (oscillators, noise, Karplus-Strong strings,
additive "piano"), arranged by the patterns below and mixed in numpy. No
samples, loops or recordings from anywhere else are used, so the result is
Replay's own work: licence "Replay original (generated)".

    python3 scripts/creative-music/generate.py            # every track
    python3 scripts/creative-music/generate.py --only matchday-anthem

Writes artifacts/api-server/assets/creative/music/replay/<key>.m4a (AAC, 44.1
kHz stereo, loudness-normalised to -14 LUFS, true peak <= -1.5 dBTP) and
library.json next to them (title, artist, mood, bpm, licence per key). The API
seeds creative_music_tracks from library.json on boot (lib/creative/music.ts)
and measures duration, loudness and the waveform itself.

Needs numpy, scipy and ffmpeg. Deterministic: the same script makes the same
files (fixed random seeds).
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import tempfile
import wave
from dataclasses import dataclass
from typing import Callable

import numpy as np
from scipy import signal

SR = 44100
HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, "..", ".."))
OUT_DIR = os.path.join(REPO, "artifacts", "api-server", "assets", "creative", "music")
LICENSE = "Replay original (generated)"
ARTIST = "Replay"

# ── Basics ────────────────────────────────────────────────────────────────────

NOTE = {"C": 0, "C#": 1, "Db": 1, "D": 2, "D#": 3, "Eb": 3, "E": 4, "F": 5, "F#": 6, "Gb": 6,
        "G": 7, "G#": 8, "Ab": 8, "A": 9, "A#": 10, "Bb": 10, "B": 11}


def midi(name: str) -> int:
    """'A4' -> 69."""
    pitch, octave = (name[:2], name[2:]) if len(name) > 2 and name[1] in "#b" else (name[:1], name[1:])
    return 12 * (int(octave) + 1) + NOTE[pitch]


def hz(m: float) -> float:
    return 440.0 * 2 ** ((m - 69) / 12)


def chord(root: str, quality: str = "") -> list[int]:
    r = midi(root)
    shapes = {"": [0, 4, 7], "m": [0, 3, 7], "7": [0, 4, 7, 10], "m7": [0, 3, 7, 10], "maj7": [0, 4, 7, 11],
              "sus2": [0, 2, 7], "sus4": [0, 5, 7], "6": [0, 4, 7, 9], "add9": [0, 4, 7, 14], "madd9": [0, 3, 7, 14]}
    return [r + i for i in shapes[quality]]


def env_exp(n: int, decay_s: float) -> np.ndarray:
    t = np.arange(n) / SR
    return np.exp(-t / max(decay_s, 1e-4))


def adsr(n: int, a: float, d: float, s: float, r: float, hold_s: float) -> np.ndarray:
    """Attack/decay/sustain for hold_s seconds, then release; length n samples."""
    t = np.arange(n) / SR
    e = np.zeros(n)
    a = max(a, 1e-4)
    e = np.where(t < a, t / a, e)
    dec = (t >= a) & (t < a + d)
    e = np.where(dec, 1 - (1 - s) * (t - a) / max(d, 1e-4), e)
    e = np.where((t >= a + d) & (t < hold_s), s, e)
    rel = t >= hold_s
    level = np.interp(hold_s, [0, a, a + d], [0, 1, s]) if hold_s < a + d else s
    e = np.where(rel, level * np.exp(-(t - hold_s) / max(r, 1e-4) * 3), e)
    return e


def noise(n: int, rng: np.random.Generator) -> np.ndarray:
    return rng.uniform(-1, 1, n)


def sos(kind: str, f, order: int = 2):
    nyq = SR / 2
    if isinstance(f, (list, tuple)):
        return signal.butter(order, [min(x / nyq, 0.99) for x in f], btype=kind, output="sos")
    return signal.butter(order, min(f / nyq, 0.99), btype=kind, output="sos")


def filt(x: np.ndarray, kind: str, f, order: int = 2) -> np.ndarray:
    return signal.sosfilt(sos(kind, f, order), x, axis=-1)


def sweep_lowpass(x: np.ndarray, f_from: float, f_to: float, block: int = 256) -> np.ndarray:
    """A low-pass whose cutoff moves exponentially from f_from to f_to over x (mono)."""
    out = np.zeros_like(x)
    zi = np.zeros((1, 2))
    n = len(x)
    for start in range(0, n, block):
        frac = start / max(n - 1, 1)
        f = f_from * (f_to / f_from) ** frac
        s = sos("low", f, 2)
        out[start:start + block], zi = signal.sosfilt(s, x[start:start + block], zi=zi)
    return out


def sweep_bandpass(x: np.ndarray, f_from: float, f_to: float, q: float = 0.6, block: int = 256) -> np.ndarray:
    out = np.zeros_like(x)
    zi = np.zeros((2, 2))
    n = len(x)
    for start in range(0, n, block):
        frac = start / max(n - 1, 1)
        f = f_from * (f_to / f_from) ** frac
        s = sos("band", [f * (1 - q / 2), f * (1 + q / 2)], 2)
        out[start:start + block], zi = signal.sosfilt(s, x[start:start + block], zi=zi)
    return out


def saw(freq: float, n: int, phase: float = 0.0, max_h: int | None = None) -> np.ndarray:
    """Band-limited sawtooth (additive)."""
    t = np.arange(n) / SR
    h_max = int((SR / 2 - 500) // max(freq, 1))
    if max_h:
        h_max = min(h_max, max_h)
    out = np.zeros(n)
    for k in range(1, max(h_max, 1) + 1):
        out += np.sin(2 * np.pi * k * freq * t + k * phase) / k
    return out * (2 / np.pi)


def square(freq: float, n: int, max_h: int = 25) -> np.ndarray:
    t = np.arange(n) / SR
    out = np.zeros(n)
    for k in range(1, 2 * max_h, 2):
        if k * freq > SR / 2 - 500:
            break
        out += np.sin(2 * np.pi * k * freq * t) / k
    return out * (4 / np.pi)


def sine(freq, n: int, phase: float = 0.0) -> np.ndarray:
    t = np.arange(n) / SR
    return np.sin(2 * np.pi * freq * t + phase)


def pan(mono: np.ndarray, p: float) -> np.ndarray:
    """p in [-1, 1]; constant-power."""
    a = (p + 1) * np.pi / 4
    return np.stack([mono * np.cos(a), mono * np.sin(a)])


class Track:
    """A stereo bus you place sounds on by time."""

    def __init__(self, seconds: float):
        self.n = int(seconds * SR)
        self.buf = np.zeros((2, self.n))

    def add(self, at_s: float, sound: np.ndarray, gain: float = 1.0, p: float = 0.0):
        if sound.ndim == 1:
            sound = pan(sound, p)
        i = int(round(at_s * SR))
        if i >= self.n:
            return
        j = min(self.n, i + sound.shape[1])
        self.buf[:, i:j] += sound[:, : j - i] * gain

    def mix(self, other: "Track", gain: float = 1.0):
        self.buf += other.buf * gain


def reverb_ir(seconds: float, rng: np.random.Generator, damp: float = 6000, predelay: float = 0.012) -> np.ndarray:
    n = int(seconds * SR)
    t = np.arange(n) / SR
    decay = np.exp(-t * 6.9 / seconds)  # -60 dB at `seconds`
    ir = np.stack([noise(n, rng), noise(n, rng)]) * decay
    ir = filt(ir, "low", damp, 1)
    pre = int(predelay * SR)
    ir = np.concatenate([np.zeros((2, pre)), ir], axis=1)
    ir[:, 0] = 0
    return ir / np.sqrt(np.sum(ir ** 2, axis=1, keepdims=True))


def reverb(x: np.ndarray, ir: np.ndarray, wet: float) -> np.ndarray:
    wet_sig = np.stack([signal.fftconvolve(x[c], ir[c])[: x.shape[1]] for c in range(2)])
    return x + wet_sig * wet


def delay(x: np.ndarray, seconds: float, feedback: float, wet: float, pingpong: bool = True) -> np.ndarray:
    d = int(seconds * SR)
    out = x.copy()
    tap = x.copy()
    for i in range(1, 6):
        g = feedback ** i
        if g < 0.02:
            break
        shifted = np.zeros_like(x)
        shifted[:, d * i:] = tap[:, : x.shape[1] - d * i]
        if pingpong and i % 2 == 1:
            shifted = shifted[::-1]
        out += shifted * g * wet
    return out


def pump(n: int, beat_s: float, depth: float = 0.6, release: float = 0.22, offset_s: float = 0.0) -> np.ndarray:
    """Side-chain style volume dip on every beat."""
    t = (np.arange(n) / SR - offset_s) % beat_s
    return 1 - depth * np.exp(-t / (release * beat_s))


# ── Instruments ───────────────────────────────────────────────────────────────

def kick(rng, punch: float = 1.0, decay: float = 0.42, f_hi: float = 160, f_lo: float = 46) -> np.ndarray:
    n = int(decay * 1.6 * SR)
    t = np.arange(n) / SR
    f = f_lo + (f_hi - f_lo) * np.exp(-t / 0.045)
    phase = 2 * np.pi * np.cumsum(f) / SR
    body = np.sin(phase) * env_exp(n, decay * 0.45)
    click = filt(noise(n, rng), "high", 2500) * env_exp(n, 0.004) * 0.5 * punch
    return np.tanh((body + click) * 1.6) * 0.9


def snare(rng, decay: float = 0.17, tone: float = 185) -> np.ndarray:
    n = int(decay * 2.2 * SR)
    body = sine(tone, n) * env_exp(n, 0.05) * 0.55
    rattle = filt(noise(n, rng), "band", [1500, 9000]) * env_exp(n, decay * 0.55)
    return (body + rattle) * 0.8


def clap(rng, decay: float = 0.16) -> np.ndarray:
    n = int((decay * 2 + 0.04) * SR)
    x = np.zeros(n)
    for k, g in zip([0.0, 0.009, 0.019], [0.7, 0.85, 1.0]):
        i = int(k * SR)
        m = n - i
        x[i:] += noise(m, rng) * env_exp(m, 0.006 if k < 0.019 else decay * 0.5) * g
    return filt(x, "band", [900, 4200]) * 1.3


def hat(rng, open_: bool = False) -> np.ndarray:
    decay = 0.16 if open_ else 0.028
    n = int(decay * 3 * SR)
    x = filt(noise(n, rng), "high", 7500, 2) * env_exp(n, decay)
    return x * (0.55 if open_ else 0.6)


def shaker(rng) -> np.ndarray:
    n = int(0.12 * SR)
    t = np.arange(n) / SR
    e = np.minimum(t / 0.012, 1) * np.exp(-np.maximum(t - 0.012, 0) / 0.035)
    return filt(noise(n, rng), "band", [4500, 11000]) * e * 0.5


def rim(rng) -> np.ndarray:
    n = int(0.06 * SR)
    return (sine(1700, n) * 0.5 + filt(noise(n, rng), "band", [2000, 6000])) * env_exp(n, 0.008) * 0.6


def tom(rng, f0: float = 110, decay: float = 0.5) -> np.ndarray:
    n = int(decay * 2 * SR)
    t = np.arange(n) / SR
    f = f0 * (1 + 0.6 * np.exp(-t / 0.03))
    body = np.sin(2 * np.pi * np.cumsum(f) / SR) * env_exp(n, decay * 0.5)
    skin = filt(noise(n, rng), "band", [200, 1200]) * env_exp(n, 0.05) * 0.35
    return np.tanh((body + skin) * 1.3) * 0.85


def timpani(rng, f0: float = 65, decay: float = 1.6) -> np.ndarray:
    n = int(decay * 1.5 * SR)
    t = np.arange(n) / SR
    f = f0 * (1 + 0.08 * np.exp(-t / 0.05))
    ph = 2 * np.pi * np.cumsum(f) / SR
    body = (np.sin(ph) + 0.45 * np.sin(1.5 * ph) + 0.25 * np.sin(1.98 * ph)) * env_exp(n, decay * 0.35)
    mallet = filt(noise(n, rng), "band", [150, 900]) * env_exp(n, 0.04) * 0.5
    return (body + mallet) * 0.6


def impact(rng, seconds: float = 3.0) -> np.ndarray:
    """A cinematic boom: sub drop + noise burst."""
    n = int(seconds * SR)
    t = np.arange(n) / SR
    f = 38 + 70 * np.exp(-t / 0.12)
    sub = np.sin(2 * np.pi * np.cumsum(f) / SR) * env_exp(n, 0.9)
    burst = filt(noise(n, rng), "low", 3500) * env_exp(n, 0.25) * 0.6
    return np.tanh((sub + burst) * 1.4) * 0.8


def riser(rng, seconds: float, f_from: float = 400, f_to: float = 9000) -> np.ndarray:
    n = int(seconds * SR)
    x = sweep_bandpass(noise(n, rng), f_from, f_to, q=0.9)
    ramp = np.linspace(0, 1, n) ** 2.2
    t = np.arange(n) / SR
    tone_f = 220 * 2 ** (2 * t / seconds)
    tone = np.sin(2 * np.pi * np.cumsum(tone_f) / SR) * 0.12
    return (x * 1.8 + tone) * ramp


def supersaw(freq: float, seconds: float, voices: int = 5, detune_c: float = 14, cutoff: float = 4500,
             a=0.01, d=0.2, s=0.8, r=0.3, max_h: int = 60) -> np.ndarray:
    n = int((seconds + r * 2) * SR)
    rng = np.random.default_rng(int(freq * 100))
    out = np.zeros((2, n))
    for v in range(voices):
        c = (v - (voices - 1) / 2) / max((voices - 1) / 2, 1) * detune_c
        f = freq * 2 ** (c / 1200)
        x = saw(f, n, phase=rng.uniform(0, 2 * np.pi), max_h=max_h)
        out += pan(x, (v - (voices - 1) / 2) / max(voices, 1) * 1.4)
    out /= voices ** 0.7
    out = filt(out, "low", cutoff, 2)
    return out * adsr(n, a, d, s, r, seconds)


def pad(notes: list[int], seconds: float, cutoff: float = 2200, gain: float = 0.18, a: float = 0.6, r: float = 1.2,
        voices: int = 4, detune: float = 10) -> np.ndarray:
    n = int((seconds + r * 2) * SR)
    out = np.zeros((2, n))
    for m in notes:
        out += supersaw(hz(m), seconds, voices=voices, detune_c=detune, cutoff=cutoff, a=a, d=0.5, s=0.9, r=r, max_h=30)[:, :n]
    return out * gain


def bass(freq: float, seconds: float, cutoff: float = 700, sub: float = 0.6, drive: float = 1.4) -> np.ndarray:
    n = int((seconds + 0.08) * SR)
    x = filt(saw(freq, n, max_h=40), "low", cutoff, 2) * 0.7 + sine(freq, n) * sub
    e = adsr(n, 0.004, 0.08, 0.85, 0.05, seconds)
    return np.tanh(x * drive) * e * 0.7


def pluck(freq: float, seconds: float, rng, brightness: float = 0.5, decay: float = 0.996) -> np.ndarray:
    """Karplus-Strong string, computed one period at a time."""
    n = int(seconds * SR)
    p = max(2, int(round(SR / freq)))
    burst = filt(noise(p, rng), "low", 1500 + 7000 * brightness, 1)
    out = np.zeros(n + p)
    out[:p] = burst
    i = p
    while i < n + p:
        j = min(i + p, n + p)
        prev = out[i - p:j - p]
        prev2 = np.concatenate([out[i - p + 1:j - p + 1]])
        if len(prev2) < len(prev):
            prev2 = np.pad(prev2, (0, len(prev) - len(prev2)))
        out[i:j] = 0.5 * (prev + prev2) * decay
        i = j
    x = out[p:n + p]
    x = filt(x, "high", 70, 1)
    return x * np.minimum(1, np.arange(n) / (0.002 * SR)) * 0.9


def mallet(freq: float, seconds: float, decay: float = 0.35) -> np.ndarray:
    """Marimba-ish: fundamental plus the bar's high partials, quick to fade."""
    n = int(seconds * SR)
    x = sine(freq, n) * env_exp(n, decay) + 0.35 * sine(freq * 3.93, n) * env_exp(n, decay * 0.22) \
        + 0.12 * sine(freq * 9.5, n) * env_exp(n, decay * 0.08)
    att = np.minimum(1, np.arange(n) / (0.0015 * SR))
    return x * att * 0.6


def piano(freq: float, seconds: float, rng, vel: float = 0.8) -> np.ndarray:
    """Additive piano-ish tone: slightly stretched partials, each with its own decay, and a hammer."""
    n = int(seconds * SR)
    x = np.zeros(n)
    B = 0.0004
    for k in range(1, 14):
        fk = freq * k * np.sqrt(1 + B * k * k)
        if fk > SR / 2 - 1000:
            break
        amp = (1 / k ** 1.15) * (0.6 + 0.4 * vel)
        dec = 2.8 / (1 + 0.45 * k) * (1.4 - freq / 2000)
        x += amp * sine(fk, n, phase=rng.uniform(0, 6.28)) * env_exp(n, max(dec, 0.15))
    hammer = filt(noise(n, rng), "band", [800, 4000]) * env_exp(n, 0.006) * 0.15 * vel
    att = np.minimum(1, np.arange(n) / (0.003 * SR))
    return (x * att + hammer) * 0.35 * vel


def strings(notes: list[int], seconds: float, gain: float = 0.16, a: float = 1.2, r: float = 1.4, cutoff: float = 3200) -> np.ndarray:
    n = int((seconds + r * 2) * SR)
    t = np.arange(n) / SR
    out = np.zeros((2, n))
    rng = np.random.default_rng(sum(notes))
    for m in notes:
        for v in range(3):
            vib = 1 + 0.0035 * np.sin(2 * np.pi * (5.2 + v * 0.3) * t + rng.uniform(0, 6))
            f = hz(m) * 2 ** ((v - 1) * 7 / 1200)
            phase = 2 * np.pi * np.cumsum(f * vib) / SR
            x = np.zeros(n)
            for k in range(1, 24):
                if k * f > SR / 2 - 800:
                    break
                x += np.sin(k * phase) / k
            out += pan(x, (v - 1) * 0.6)
    out = filt(out, "low", cutoff, 2)
    return out * adsr(n, a, 0.4, 0.9, r, seconds) * gain / max(len(notes), 1) ** 0.5


def brass(freq: float, seconds: float, gain: float = 0.5) -> np.ndarray:
    n = int((seconds + 0.25) * SR)
    x = saw(freq, n, max_h=40) + 0.6 * saw(freq * 1.003, n, max_h=40)
    fenv = 600 + 3400 * adsr(n, 0.04, 0.25, 0.4, 0.15, seconds)
    # filter envelope: approximate with three blended static filters
    lo = filt(x, "low", 800, 2)
    mid = filt(x, "low", 2000, 2)
    hi = filt(x, "low", 4000, 2)
    w = (fenv - 600) / 3400
    y = np.where(w < 0.5, lo * (1 - 2 * w) + mid * 2 * w, mid * (2 - 2 * w) + hi * (2 * w - 1))
    return np.tanh(y * 1.2) * adsr(n, 0.03, 0.2, 0.75, 0.12, seconds) * gain


def lead(freq: float, seconds: float, vib: float = 0.006) -> np.ndarray:
    """A soft whistle-like lead (sine + a touch of 2nd/3rd harmonic, vibrato after onset)."""
    n = int((seconds + 0.12) * SR)
    t = np.arange(n) / SR
    v = 1 + vib * np.sin(2 * np.pi * 5.5 * t) * np.minimum(1, t / 0.25)
    ph = 2 * np.pi * np.cumsum(freq * v) / SR
    x = np.sin(ph) + 0.18 * np.sin(2 * ph) + 0.07 * np.sin(3 * ph)
    return x * adsr(n, 0.015, 0.08, 0.8, 0.08, seconds) * 0.45


# ── Mixing ────────────────────────────────────────────────────────────────────

def master(x: np.ndarray, drive: float = 1.0) -> np.ndarray:
    x = filt(x, "high", 28, 2)
    peak = np.max(np.abs(x)) or 1
    x = x / peak
    # gentle bus saturation
    x = np.tanh(x * 1.2 * drive) / np.tanh(1.2 * drive)
    # tiny fade at both ends so loops click-free
    n = x.shape[1]
    fade_in = int(0.004 * SR)
    x[:, :fade_in] *= np.linspace(0, 1, fade_in)
    return x / (np.max(np.abs(x)) or 1) * 0.89


def tail_fade(x: np.ndarray, seconds: float) -> np.ndarray:
    n = int(seconds * SR)
    x[:, -n:] *= np.linspace(1, 0, n) ** 1.5
    return x


# ── The tracks ────────────────────────────────────────────────────────────────

@dataclass
class Spec:
    key: str
    title: str
    mood: str
    bpm: int
    build: Callable[[], np.ndarray]


def matchday_anthem() -> np.ndarray:
    """Hype, 128 bpm, A minor: four-on-the-floor festival drop with a riser into it."""
    rng = np.random.default_rng(1)
    bpm = 128
    beat = 60 / bpm
    bar = beat * 4
    bars = 20
    T = Track(bars * bar + 2.5)
    drums, music, fx = Track(T.n / SR), Track(T.n / SR), Track(T.n / SR)
    prog = [chord("A3", "m"), chord("F3"), chord("C4"), chord("G3")]
    roots = [midi("A1"), midi("F1"), midi("C2"), midi("G1")]
    k, s, c = kick(rng), snare(rng), clap(rng)
    ch, oh = hat(rng), hat(rng, True)
    # sections: 0-3 intro (filtered), 4-11 drop, 12-13 break, 14-19 drop 2
    for b in range(bars):
        t0 = b * bar
        chd = prog[b % 4]
        intro, brk = b < 4, 12 <= b < 14
        for q in range(4):
            tq = t0 + q * beat
            if not brk and not (intro and b < 2):
                drums.add(tq, k, 0.95)
            if not intro and not brk and q in (1, 3):
                drums.add(tq, c, 0.55, 0.05)
                drums.add(tq, s, 0.3)
            if not brk:
                drums.add(tq + beat / 2, oh if not intro else ch, 0.28 if not intro else 0.22, 0.25)
            for e in range(4):
                if not brk and (not intro or e % 2 == 0):
                    drums.add(tq + e * beat / 4, ch, 0.13 + 0.05 * (e == 2), -0.3)
        # chords: offbeat stabs in the drop, sustained in intro/break
        if intro or brk:
            p = pad([m + 12 for m in chd], bar * 0.98, cutoff=900 if intro else 1600, gain=0.2, a=0.3, r=0.6)
            music.add(t0, p, 1.0)
        else:
            for e in range(8):
                if e % 2 == 1 or e == 0:
                    st = np.zeros((2, 1))
                    for m in chd:
                        st = _sum(st, supersaw(hz(m + 12), beat * 0.42, voices=7, detune_c=18, cutoff=5200, a=0.003, d=0.12, s=0.55, r=0.08))
                    music.add(t0 + e * beat / 2, st, 0.11)
            # bass on 8ths, root/octave
            for e in range(8):
                f = hz(roots[b % 4] + (12 if e % 2 else 0))
                music.add(t0 + e * beat / 2, bass(f, beat * 0.42, cutoff=900), 0.42)
            # hook melody (top line), every 2 bars
            hook = [0, 3, 7, 3, 10, 7, 3, 2] if b % 2 == 0 else [0, 3, 7, 12, 10, 7, 5, 3]
            for e, iv in enumerate(hook):
                f = hz(midi("A4") + iv + (prog[b % 4][0] - prog[0][0]) * 0 )
                music.add(t0 + e * beat / 2, supersaw(f, beat * 0.4, voices=3, detune_c=8, cutoff=6000, a=0.004, d=0.1, s=0.6, r=0.1, max_h=40), 0.08, 0.15)
        # risers into each drop
        if b in (2, 12):
            fx.add(t0, riser(rng, bar * 2), 0.32)
        if b in (4, 14):
            fx.add(t0, impact(rng, 2.5), 0.45)
    fx.add(bars * bar, impact(rng, 2.5), 0.5)
    fx.add(bars * bar, pad([m + 12 for m in prog[0]], 0.5, cutoff=2500, gain=0.22, a=0.01, r=1.8), 1.0)
    ir = reverb_ir(1.8, rng)
    n = T.n
    pm = pump(n, beat, 0.55, 0.28)
    # the pump only during drops
    mask = np.ones(n)
    for b in list(range(0, 4)) + [12, 13]:
        mask[int(b * bar * SR):int((b + 1) * bar * SR)] = 0
    pm = 1 - (1 - pm) * mask
    music.buf = reverb(delay(music.buf, beat * 0.75, 0.3, 0.18), ir, 0.22) * pm
    fx.buf = reverb(fx.buf, ir, 0.35)
    drums.buf = reverb(drums.buf, reverb_ir(0.6, rng), 0.08)
    T.mix(drums, 1.0)
    T.mix(music, 1.0)
    T.mix(fx, 1.0)
    return tail_fade(master(T.buf, 1.1), 2.0)


def _sum(a: np.ndarray, b: np.ndarray) -> np.ndarray:
    n = max(a.shape[1], b.shape[1])
    out = np.zeros((2, n))
    out[:, : a.shape[1]] += a
    out[:, : b.shape[1]] += b
    return out


def stadium_stomp() -> np.ndarray:
    """Hype, 96 bpm, D minor: stomp-stomp-clap with toms, brass stabs and a driving bass."""
    rng = np.random.default_rng(2)
    bpm = 96
    beat = 60 / bpm
    bar = beat * 4
    bars = 16
    T = Track(bars * bar + 2.5)
    drums, music = Track(T.n / SR), Track(T.n / SR)
    k = kick(rng, punch=1.2, decay=0.5, f_hi=130, f_lo=50)
    c = clap(rng, 0.22)
    t_hi, t_lo = tom(rng, 140, 0.45), tom(rng, 95, 0.6)
    ch = hat(rng)
    prog = [("D3", "m"), ("Bb2", ""), ("C3", ""), ("A2", "")]
    for b in range(bars):
        t0 = b * bar
        full = b >= 4
        for half in (0, 2):
            drums.add(t0 + half * beat, k, 1.0)
            drums.add(t0 + half * beat + beat / 2, k, 0.85)
            drums.add(t0 + (half + 1) * beat, c, 0.75)
            drums.add(t0 + (half + 1) * beat, t_lo, 0.35 if full else 0.0, 0.2)
        if full:
            for e in range(8):
                drums.add(t0 + e * beat / 2, ch, 0.12 + 0.06 * (e % 2), 0.35)
        if b % 4 == 3:
            for e, tt in enumerate([t_hi, t_hi, t_lo, t_lo]):
                drums.add(t0 + 3 * beat + e * beat / 4, tt, 0.55, -0.4 + e * 0.25)
        root, q = prog[b % 4]
        notes = chord(root, q)
        if full:
            # brass stabs: on 1, the "and" of 2 and on 4
            for at, dur in [(0, 0.6), (1.5, 0.35), (3, 0.45)]:
                st = np.zeros((2, 1))
                for m in [notes[0] + 12, notes[1] + 12, notes[2] + 12]:
                    st = _sum(st, pan(brass(hz(m), beat * dur), 0.0))
                music.add(t0 + at * beat, st, 0.28)
            for e in range(8):
                f = hz(notes[0] - 12 + (0 if e not in (3, 7) else 7))
                music.add(t0 + e * beat / 2, bass(f, beat * 0.45, cutoff=700, drive=1.8), 0.48)
        else:
            music.add(t0, pad([n + 12 for n in notes], bar, cutoff=1200, gain=0.16, a=0.4, r=0.8), 1.0)
            music.add(t0, bass(hz(notes[0] - 12), bar * 0.95, cutoff=400), 0.45)
        if b == 3:
            music.add(t0, riser(rng, bar), 0.28)
    music.add(bars * bar, impact(rng, 2.5), 0.55)
    st = np.zeros((2, 1))
    for m in chord("D3", "m"):
        st = _sum(st, pan(brass(hz(m + 12), 1.4), 0))
    music.add(bars * bar, st, 0.3)
    ir = reverb_ir(2.2, rng)  # a big room for the stadium
    drums.buf = reverb(drums.buf, ir, 0.28)
    music.buf = reverb(music.buf, ir, 0.2)
    T.mix(drums)
    T.mix(music)
    return tail_fade(master(T.buf, 1.15), 2.0)


def final_whistle() -> np.ndarray:
    """Epic, 84 bpm, C minor: string ostinato, timpani, brass swell to a big ending."""
    rng = np.random.default_rng(3)
    bpm = 84
    beat = 60 / bpm
    bar = beat * 4
    bars = 14
    T = Track(bars * bar + 4)
    orch, perc = Track(T.n / SR), Track(T.n / SR)
    prog = [("C3", "m"), ("Ab2", ""), ("Eb3", ""), ("Bb2", "")]
    for b in range(bars):
        t0 = b * bar
        root, q = prog[b % 4]
        notes = chord(root, q)
        intensity = min(1.0, 0.35 + b / 9)
        # low strings: 8th-note ostinato on the root
        for e in range(8):
            f = hz(notes[0] - (0 if e % 4 else 12) + 0)
            orch.add(t0 + e * beat / 2, strings([notes[0] - 12 + (12 if e % 2 else 0)], beat * 0.45, gain=0.5, a=0.02, r=0.12, cutoff=1800), 0.55 * intensity)
        # high strings sustain
        orch.add(t0, strings([n + 12 for n in notes], bar, gain=0.3, a=0.8, r=1.0, cutoff=3500), 0.8 * intensity)
        # timpani
        perc.add(t0, timpani(rng, hz(notes[0] - 12)), 0.7 * intensity)
        if b >= 4:
            perc.add(t0 + 2.5 * beat, timpani(rng, hz(notes[0] - 12), 0.6), 0.4 * intensity)
            perc.add(t0 + 3 * beat, timpani(rng, hz(notes[0] - 12), 0.6), 0.45 * intensity)
        if b >= 8:
            for m in notes:
                orch.add(t0, pan(brass(hz(m), bar * 0.9, 0.35), 0), 0.38)
            perc.add(t0 + beat, snare(rng, 0.25), 0.2)
            perc.add(t0 + 3 * beat, snare(rng, 0.25), 0.2)
        if b == 7:
            perc.add(t0, riser(rng, bar, 200, 5000), 0.18)
            for e in range(8):
                perc.add(t0 + 2 * beat + e * beat / 4, timpani(rng, hz(notes[0] - 12), 0.4), 0.18 + e * 0.05)
    end = bars * bar
    perc.add(end, impact(rng, 4), 0.6)
    perc.add(end, timpani(rng, hz(midi("C2")), 2.5), 0.9)
    orch.add(end, strings([n + 12 for n in chord("C3", "m")] + [midi("C3")], 2.0, gain=0.4, a=0.02, r=1.6), 1.0)
    for m in chord("C3", "m"):
        orch.add(end, pan(brass(hz(m), 1.8, 0.4), 0), 0.4)
    ir = reverb_ir(3.2, rng, damp=5000, predelay=0.03)
    orch.buf = reverb(orch.buf, ir, 0.45)
    perc.buf = reverb(perc.buf, ir, 0.35)
    T.mix(orch)
    T.mix(perc)
    return tail_fade(master(T.buf, 1.0), 2.5)


def rising_star() -> np.ndarray:
    """Cinematic, 100 bpm, E minor: pulsing synth ostinato building to impacts."""
    rng = np.random.default_rng(4)
    bpm = 100
    beat = 60 / bpm
    bar = beat * 4
    bars = 16
    T = Track(bars * bar + 3.5)
    syn, low, fx = Track(T.n / SR), Track(T.n / SR), Track(T.n / SR)
    prog = [("E3", "m"), ("C3", ""), ("G3", ""), ("D3", "")]
    arp = [0, 7, 12, 7, 3, 7, 12, 15]
    for b in range(bars):
        t0 = b * bar
        root, q = prog[b % 4]
        notes = chord(root, q)
        build = b / (bars - 1)
        cutoff = 900 + 4200 * build
        for e in range(16):
            iv = arp[e % 8]
            m = notes[0] + 12 + iv if q == "m" else notes[0] + 12 + [0, 7, 12, 7, 4, 7, 12, 16][e % 8]
            x = supersaw(hz(m), beat * 0.2, voices=3, detune_c=9, cutoff=cutoff, a=0.002, d=0.08, s=0.4, r=0.06, max_h=40)
            syn.add(t0 + e * beat / 4, x, 0.075, 0.0)
        low.add(t0, pad([notes[0] - 12, notes[0]], bar, cutoff=600, gain=0.25, a=0.5, r=0.8), 1.0)
        low.add(t0, pad([n + 12 for n in notes], bar, cutoff=1500 + 1500 * build, gain=0.12, a=1.0, r=1.2), 1.0)
        if b >= 8:
            low.add(t0, kick(rng, 0.6, 0.6, 110, 40), 0.7)
            low.add(t0 + 2 * beat, kick(rng, 0.6, 0.6, 110, 40), 0.6)
            for qq in (1, 3):
                fx.add(t0 + qq * beat, snare(rng, 0.3, 160), 0.28)
        if b in (6, 14):
            fx.add(t0, riser(rng, bar * 2, 300, 10000), 0.3)
        if b in (8,):
            fx.add(t0, impact(rng, 3), 0.55)
    fx.add(bars * bar, impact(rng, 3.5), 0.6)
    low.add(bars * bar, pad([midi("E2"), midi("B2"), midi("E3"), midi("G3")], 0.8, cutoff=2400, gain=0.25, a=0.01, r=2.0), 1.0)
    ir = reverb_ir(2.6, rng, damp=7000)
    syn.buf = reverb(delay(syn.buf, beat * 0.75, 0.35, 0.3), ir, 0.3)
    low.buf = reverb(low.buf, ir, 0.3)
    fx.buf = reverb(fx.buf, ir, 0.4)
    T.mix(syn)
    T.mix(low)
    T.mix(fx)
    return tail_fade(master(T.buf, 1.0), 2.5)


def sunday_session() -> np.ndarray:
    """Chill, 88 bpm, G major: Karplus-Strong guitar arpeggios, soft groove, warm pad."""
    rng = np.random.default_rng(5)
    bpm = 88
    beat = 60 / bpm
    bar = beat * 4
    bars = 16
    T = Track(bars * bar + 3)
    gtr, groove, warm = Track(T.n / SR), Track(T.n / SR), Track(T.n / SR)
    prog = [("G3", "maj7"), ("E3", "m7"), ("C3", "maj7"), ("D3", "6")]
    pattern = [0, 2, 1, 3, 2, 1, 3, 2]
    swing = 0.04
    k = kick(rng, 0.4, 0.35, 120, 48)
    for b in range(bars):
        t0 = b * bar
        root, q = prog[b % 4]
        notes = chord(root, q)
        voicing = [notes[0] - 12] + notes[1:] + [notes[1] + 12]
        for e, idx in enumerate(pattern):
            m = voicing[0] if e == 0 else voicing[1 + idx % (len(voicing) - 1)]
            at = t0 + e * beat / 2 + (swing if e % 2 else 0)
            gtr.add(at, pluck(hz(m), 2.2, rng, brightness=0.35 + 0.1 * (e % 3), decay=0.997), 0.32, -0.25 + 0.5 * (e % 2))
        if b >= 2:
            groove.add(t0, k, 0.55)
            groove.add(t0 + 2.5 * beat, k, 0.4)
            groove.add(t0 + beat, rim(rng), 0.3, 0.1)
            groove.add(t0 + 3 * beat, rim(rng), 0.3, 0.1)
            for e in range(8):
                groove.add(t0 + e * beat / 2 + (swing if e % 2 else 0), shaker(rng), 0.25 + 0.15 * (e % 2), 0.4)
            groove.add(t0, bass(hz(notes[0] - 12), beat * 1.4, cutoff=380, sub=0.9, drive=1.0), 0.42)
            groove.add(t0 + 2.5 * beat, bass(hz(notes[0] - 12 + 7), beat * 0.9, cutoff=380, sub=0.9, drive=1.0), 0.35)
        warm.add(t0, pad([n + 12 for n in notes[:3]], bar, cutoff=1300, gain=0.11, a=0.9, r=1.4, voices=3, detune=7), 1.0)
        if b >= 8 and b % 2 == 0:
            mel = [7, 9, 11, 9, 7, 4, 2, 4]
            for e, iv in enumerate(mel):
                warm.add(t0 + e * beat, lead(hz(midi("G4") + iv), beat * 0.85, 0.004), 0.16, 0.2)
    gtr.add(bars * bar, pluck(hz(midi("G2")), 3, rng, 0.4), 0.4)
    for m in chord("G3", "maj7"):
        gtr.add(bars * bar + 0.03 * (m % 4), pluck(hz(m), 3, rng, 0.4), 0.3)
    ir = reverb_ir(1.6, rng, damp=5500)
    gtr.buf = reverb(gtr.buf, ir, 0.3)
    warm.buf = reverb(warm.buf, ir, 0.35)
    groove.buf = reverb(groove.buf, reverb_ir(0.5, rng), 0.1)
    T.mix(gtr)
    T.mix(groove)
    T.mix(warm)
    return tail_fade(master(T.buf, 0.9), 2.5)


def little_legends() -> np.ndarray:
    """Fun, 116 bpm, C major: bouncy marimba hook, claps, whistle lead."""
    rng = np.random.default_rng(6)
    bpm = 116
    beat = 60 / bpm
    bar = beat * 4
    bars = 16
    T = Track(bars * bar + 2.5)
    mar, drums, top = Track(T.n / SR), Track(T.n / SR), Track(T.n / SR)
    prog = [("C4", ""), ("G3", ""), ("A3", "m"), ("F3", "")]
    k, c, ch = kick(rng, 0.8, 0.32, 150, 55), clap(rng, 0.13), hat(rng)
    hook = [0, 2, 4, 7, 4, 2, 0, -1, 0, 4, 7, 9, 7, 4, 2, 0]
    for b in range(bars):
        t0 = b * bar
        root, q = prog[b % 4]
        notes = chord(root, q)
        # marimba: chord tones bouncing in 8ths
        for e in range(8):
            m = notes[[0, 1, 2, 1, 0, 2, 1, 2][e]] + (12 if e in (3, 7) else 0)
            mar.add(t0 + e * beat / 2, mallet(hz(m), 0.6), 0.5, -0.3 + 0.6 * (e % 2))
        if b >= 2:
            drums.add(t0, k, 0.8)
            drums.add(t0 + 2 * beat, k, 0.8)
            drums.add(t0 + 2.75 * beat, k, 0.45)
            drums.add(t0 + beat, c, 0.55)
            drums.add(t0 + 3 * beat, c, 0.55)
            for e in range(8):
                drums.add(t0 + e * beat / 2, ch, 0.1 + 0.05 * (e % 2), 0.3)
            for e, iv in enumerate([0, 0, 7, 0]):
                drums.add(t0 + e * beat, bass(hz(notes[0] - 24 + iv), beat * 0.35, cutoff=600, sub=0.7, drive=1.2), 0.45)
        if b >= 4:
            # whistle hook, scale degrees in C major
            scale = [0, 2, 4, 5, 7, 9, 11]
            for e in range(8):
                deg = hook[(b % 2) * 8 + e]
                octave, idx = divmod(deg, 7)
                m = midi("C5") + 12 * octave + scale[idx]
                if (b % 4 == 3) and e >= 6:
                    continue
                top.add(t0 + e * beat / 2, lead(hz(m), beat * 0.42), 0.32, 0.15)
        if b == 11:
            for e in range(8):
                top.add(t0 + 2 * beat + e * beat / 4, mallet(hz(midi("C5") + 2 * e), 0.3), 0.4, -0.5 + e / 8)
    end = bars * bar
    for m in chord("C4"):
        mar.add(end, mallet(hz(m), 1.6, 0.6), 0.6)
        mar.add(end, mallet(hz(m + 12), 1.6, 0.6), 0.35)
    drums.add(end, k, 0.8)
    drums.add(end, c, 0.6)
    ir = reverb_ir(1.2, rng)
    mar.buf = reverb(mar.buf, ir, 0.2)
    top.buf = reverb(delay(top.buf, beat * 0.5, 0.25, 0.2), ir, 0.25)
    drums.buf = reverb(drums.buf, reverb_ir(0.5, rng), 0.08)
    T.mix(mar)
    T.mix(drums)
    T.mix(top)
    return tail_fade(master(T.buf, 1.0), 1.8)


def proud_moments() -> np.ndarray:
    """Emotional, 72 bpm, F major: piano arpeggios over strings, a melody in the second half."""
    rng = np.random.default_rng(7)
    bpm = 72
    beat = 60 / bpm
    bar = beat * 4
    bars = 12
    T = Track(bars * bar + 4)
    pno, strg = Track(T.n / SR), Track(T.n / SR)
    prog = [("F3", "add9"), ("C3", ""), ("D3", "m7"), ("Bb2", "maj7")]
    for b in range(bars):
        t0 = b * bar
        root, q = prog[b % 4]
        notes = chord(root, q)
        arp = [notes[0] - 12, notes[0], notes[1], notes[2], notes[-1] + (0 if notes[-1] - notes[0] > 12 else 12), notes[2], notes[1], notes[0]]
        for e, m in enumerate(arp):
            pno.add(t0 + e * beat / 2, piano(hz(m), 3.0, rng, 0.55 + 0.15 * (e == 0)), 0.55, -0.15 + 0.3 * (m % 2))
        if b >= 2:
            strg.add(t0, strings([n + 12 for n in notes[:3]], bar, gain=0.22, a=1.4, r=1.6, cutoff=2600), 1.0)
            strg.add(t0, strings([notes[0] - 12], bar, gain=0.28, a=0.8, r=1.2, cutoff=900), 1.0)
        if b >= 6:
            mel = {0: [12, 14, 16, 19], 1: [16, 14, 12, 11], 2: [9, 12, 14, 12], 3: [10, 9, 7, 5]}[b % 4]
            for e, iv in enumerate(mel):
                pno.add(t0 + e * beat, piano(hz(midi("F4") + iv), 2.2, rng, 0.8), 0.6, 0.1)
    end = bars * bar
    for m in [midi("F2"), midi("C3")] + chord("F3", "add9"):
        pno.add(end, piano(hz(m), 4, rng, 0.7), 0.5)
    strg.add(end, strings([n + 12 for n in chord("F3")], 2.5, gain=0.22, a=0.6, r=1.8), 1.0)
    ir = reverb_ir(2.8, rng, damp=4500, predelay=0.02)
    pno.buf = reverb(pno.buf, ir, 0.35)
    strg.buf = reverb(strg.buf, ir, 0.45)
    T.mix(pno)
    T.mix(strg)
    return tail_fade(master(T.buf, 0.85), 3.0)


TRACKS = [
    Spec("replay/matchday-anthem", "Matchday Anthem", "hype", 128, matchday_anthem),
    Spec("replay/stadium-stomp", "Stadium Stomp", "hype", 96, stadium_stomp),
    Spec("replay/final-whistle", "Final Whistle", "epic", 84, final_whistle),
    Spec("replay/rising-star", "Rising Star", "cinematic", 100, rising_star),
    Spec("replay/sunday-session", "Sunday Session", "chill", 88, sunday_session),
    Spec("replay/little-legends", "Little Legends", "fun", 116, little_legends),
    Spec("replay/proud-moments", "Proud Moments", "emotional", 72, proud_moments),
]


# ── Output ────────────────────────────────────────────────────────────────────

def write_wav(path: str, x: np.ndarray) -> None:
    pcm = np.clip(x.T, -1, 1)
    pcm = (pcm * 32767).astype("<i2")
    with wave.open(path, "wb") as w:
        w.setnchannels(2)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes(pcm.tobytes())


def loudnorm_encode(wav: str, out: str, target: float = -14.0, tp: float = -1.5) -> None:
    """Two-pass EBU R128 normalisation, then AAC in an m4a."""
    probe = subprocess.run(
        ["ffmpeg", "-nostdin", "-hide_banner", "-i", wav, "-af", f"loudnorm=I={target}:TP={tp}:LRA=11:print_format=json", "-f", "null", "-"],
        capture_output=True, text=True, check=True,
    ).stderr
    stats = json.loads(probe[probe.rindex("{"):probe.rindex("}") + 1])
    af = (f"loudnorm=I={target}:TP={tp}:LRA=11:measured_I={stats['input_i']}:measured_TP={stats['input_tp']}"
          f":measured_LRA={stats['input_lra']}:measured_thresh={stats['input_thresh']}:offset={stats['target_offset']}:linear=true,"
          f"aresample=44100")
    subprocess.run(
        ["ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error", "-y", "-i", wav, "-af", af,
         "-c:a", "aac", "-b:a", "160k", "-ac", "2", "-ar", "44100", "-movflags", "+faststart", "-map_metadata", "-1", out],
        check=True,
    )


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--only", help="one key's slug, e.g. matchday-anthem")
    ap.add_argument("--wav", action="store_true", help="also keep the WAVs (for listening)")
    args = ap.parse_args()
    os.makedirs(os.path.join(OUT_DIR, "replay"), exist_ok=True)
    library = []
    for spec in TRACKS:
        library.append({"key": spec.key, "title": spec.title, "artist": ARTIST, "mood": spec.mood, "bpm": spec.bpm, "license": LICENSE})
        if args.only and not spec.key.endswith("/" + args.only):
            continue
        x = spec.build()
        assert np.isfinite(x).all(), spec.key
        with tempfile.TemporaryDirectory() as tmp:
            wav = os.path.join(tmp, "x.wav")
            write_wav(wav, x)
            out = os.path.join(OUT_DIR, f"{spec.key}.m4a")
            loudnorm_encode(wav, out)
            if args.wav:
                write_wav(os.path.join(OUT_DIR, f"{spec.key}.wav"), x)
        print(f"{spec.key}: {x.shape[1] / SR:.1f}s -> {os.path.relpath(out, REPO)}", file=sys.stderr)
    lib_path = os.path.join(OUT_DIR, "library.json")
    try:
        # Keep entries this script doesn't own (e.g. cc0/* from import_cc0.py).
        with open(lib_path) as f:
            library += [e for e in json.load(f).get("tracks", []) if not e["key"].startswith("replay/")]
    except (OSError, ValueError):
        pass
    with open(lib_path, "w") as f:
        json.dump({"license": LICENSE, "note": "replay/* generated by scripts/creative-music/generate.py; cc0/* imported by scripts/creative-music/import_cc0.py. Seeded into creative_music_tracks on boot.", "tracks": library}, f, indent=2, ensure_ascii=False)
        f.write("\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
