/*
 * Nota isimleri, frekans dönüşümleri, şarkı metni ayrıştırma ve hazır şarkılar.
 */
(function (root) {
  'use strict';

  const SOLFEGE = ['Do', 'Do♯', 'Re', 'Re♯', 'Mi', 'Fa', 'Fa♯', 'Sol', 'Sol♯', 'La', 'La♯', 'Si'];
  const LETTERS = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'];
  const SOLFEGE_PC = { do: 0, re: 2, mi: 4, fa: 5, sol: 7, la: 9, si: 11 };
  const LETTER_PC = { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 };

  function freqToMidi(f, a4 = 440) {
    return 69 + 12 * Math.log2(f / a4);
  }

  function midiToFreq(m, a4 = 440) {
    return a4 * Math.pow(2, (m - 69) / 12);
  }

  function noteParts(midi, naming = 'solfege') {
    const r = Math.round(midi);
    const pc = ((r % 12) + 12) % 12;
    return { name: (naming === 'letter' ? LETTERS : SOLFEGE)[pc], octave: Math.floor(r / 12) - 1, pc };
  }

  function noteLabel(midi, naming) {
    const p = noteParts(midi, naming);
    return p.name + p.octave;
  }

  function isBlackKey(midi) {
    const pc = ((Math.round(midi) % 12) + 12) % 12;
    return pc === 1 || pc === 3 || pc === 6 || pc === 8 || pc === 10;
  }

  // Do5, Re#5, Sib4, C5, F#5, Bb4, Sol (oktavsız) … isteğe bağlı ":süre" ile.
  const NOTE_RE = /^(do|re|mi|fa|sol|la|si|[a-g])([#♯b♭]?)(-?\d)?(?::(\d+(?:[.,]\d+)?))?$/i;
  const REST_RE = /^(?:-|_|r|es)(?::(\d+(?:[.,]\d+)?))?$/i;

  function parseBeats(s) {
    return s == null ? 1 : parseFloat(s.replace(',', '.'));
  }

  /**
   * Boşlukla ayrılmış nota metnini çözer. Es (sus) notaları midi: null olur.
   * Oktav yazılmazsa bir önceki notanın oktavı kullanılır (başlangıçta 5).
   */
  function parseSong(text) {
    const notes = [];
    const errors = [];
    let octave = 5;
    for (const tok of String(text).split(/[\s|]+/)) {
      if (!tok) continue;
      let m = REST_RE.exec(tok);
      if (m) {
        const beats = parseBeats(m[1]);
        if (beats > 0 && beats <= 16) notes.push({ midi: null, beats });
        else errors.push(tok);
        continue;
      }
      m = NOTE_RE.exec(tok);
      if (!m) {
        errors.push(tok);
        continue;
      }
      const base = m[1].toLowerCase();
      const pc = base.length > 1 ? SOLFEGE_PC[base] : LETTER_PC[base];
      const accCh = m[2].toLowerCase();
      const acc = accCh === '#' || accCh === '♯' ? 1 : accCh === 'b' || accCh === '♭' ? -1 : 0;
      if (m[3] != null) octave = parseInt(m[3], 10);
      const beats = parseBeats(m[4]);
      if (!(beats > 0 && beats <= 16)) {
        errors.push(tok);
        continue;
      }
      notes.push({ midi: (octave + 1) * 12 + pc + acc, beats });
    }
    return { notes, errors };
  }

  // Islık için rahat aralıkta (çoğunlukla 5. oktav) yazıldı.
  const SONGS = [
    {
      id: 'gam', group: 'Alıştırmalar', title: 'Do majör gam', bpm: 80,
      text: 'C5 D5 E5 F5 G5 A5 B5 C6:2 | B5 A5 G5 F5 E5 D5 C5:2',
    },
    {
      id: 'arpej', group: 'Alıştırmalar', title: 'Do – Mi – Sol atlamaları', bpm: 80,
      text: 'C5 E5 G5 C6:2 G5 E5 C5:2 | C5 G5 E5 C6 G5:2 C5:2',
    },
    {
      id: 'ucnota', group: 'Alıştırmalar', title: 'Üç nota (başlangıç)', bpm: 70,
      text: 'E5 D5 C5:2 E5 D5 C5:2 | C5 D5 E5:2 E5 D5 C5:2',
    },
    {
      id: 'twinkle', group: 'Şarkılar', title: 'Parla Parla Küçük Yıldız', bpm: 90,
      text:
        'C5 C5 G5 G5 A5 A5 G5:2 | F5 F5 E5 E5 D5 D5 C5:2 | ' +
        'G5 G5 F5 F5 E5 E5 D5:2 | G5 G5 F5 F5 E5 E5 D5:2 | ' +
        'C5 C5 G5 G5 A5 A5 G5:2 | F5 F5 E5 E5 D5 D5 C5:2',
    },
    {
      id: 'mary', group: 'Şarkılar', title: 'Mary Had a Little Lamb', bpm: 100,
      text: 'E5 D5 C5 D5 E5 E5 E5:2 | D5 D5 D5:2 E5 G5 G5:2 | E5 D5 C5 D5 E5 E5 E5 E5 | D5 D5 E5 D5 C5:4',
    },
    {
      id: 'ode', group: 'Şarkılar', title: 'Neşeye Övgü (Beethoven)', bpm: 100,
      text:
        'E5 E5 F5 G5 G5 F5 E5 D5 | C5 C5 D5 E5 E5:1.5 D5:0.5 D5:2 | ' +
        'E5 E5 F5 G5 G5 F5 E5 D5 | C5 C5 D5 E5 D5:1.5 C5:0.5 C5:2',
    },
    {
      id: 'jacques', group: 'Şarkılar', title: 'Frère Jacques', bpm: 100,
      text:
        'G5 A5 B5 G5 G5 A5 B5 G5 | B5 C6 D6:2 B5 C6 D6:2 | ' +
        'D6:0.5 E6:0.5 D6:0.5 C6:0.5 B5 G5 D6:0.5 E6:0.5 D6:0.5 C6:0.5 B5 G5 | ' +
        'G5 D5 G5:2 G5 D5 G5:2',
    },
    {
      id: 'birthday', group: 'Şarkılar', title: 'İyi ki Doğdun', bpm: 90,
      text:
        'C5:0.75 C5:0.25 D5 C5 F5 E5:2 | C5:0.75 C5:0.25 D5 C5 G5 F5:2 | ' +
        'C5:0.75 C5:0.25 C6 A5 F5 E5 D5:2 | Bb5:0.75 Bb5:0.25 A5 F5 G5 F5:2',
    },
    {
      id: 'jingle', group: 'Şarkılar', title: 'Jingle Bells', bpm: 110,
      text:
        'E5 E5 E5:2 E5 E5 E5:2 | E5 G5 C5:1.5 D5:0.5 E5:4 | ' +
        'F5 F5 F5:1.5 F5:0.5 F5 E5 E5 E5:0.5 E5:0.5 | E5 D5 D5 E5 D5:2 G5:2 | ' +
        'E5 E5 E5:2 E5 E5 E5:2 | E5 G5 C5:1.5 D5:0.5 E5:4 | ' +
        'F5 F5 F5 F5 F5 E5 E5 E5:0.5 E5:0.5 | G5 G5 F5 D5 C5:4',
    },
    // Brahms, Macar Dansı No. 5 (2/4). Orijinali Fa♯ minör; ıslık aralığı için La minöre taşındı.
    // Asıl tempo ~136 BPM.
    {
      id: 'macar5', group: 'Klasik', title: 'Macar Dansı No. 5 — ana tema (Brahms)', bpm: 80,
      text:
        'E5:1.5 A5:0.5 | C6:1.5 A5:0.5 | G#5:1.5 A5:0.25 B5:0.25 | A5:2 | ' +
        'F5:1.5 G5:0.25 A5:0.25 | E5:2 | D5:0.25 C5:0.25 C5:0.25 B4:0.25 B4:0.75 E5:0.25 | A4:2 | ' +
        'E5:1.5 A5:0.25 C6:0.25 | E6:1.5 C6:0.5 | B5:1.5 C6:0.25 D6:0.25 | C6:2 | ' +
        'F5:0.25 G5:0.25 A5:0.25 F5:0.25 E5:0.25 F5:0.25 G5:0.25 E5:0.25 | ' +
        'D5:0.25 E5:0.25 F5:0.25 D5:0.25 C5:0.25 D5:0.25 E5:0.25 C5:0.25 | ' +
        'D5:0.25 C5:0.25 C5:0.25 B4:0.25 B4:0.75 E5:0.25 | A4:2',
    },
    {
      id: 'macar5b', group: 'Klasik', title: 'Macar Dansı No. 5 — ikinci tema (Brahms)', bpm: 80,
      text:
        'E6:0.5 -:0.5 E6:0.5 -:0.5 | F6:1.5 E6:0.5 | -:0.5 D6 C#6:0.25 D6:0.25 | ' +
        'E6:0.25 D6:0.25 C#6:0.25 E6:0.25 D6:0.5 -:0.5 | ' +
        'D6:0.5 -:0.5 D6:0.5 -:0.5 | E6:1.5 D6:0.5 | -:0.5 C6 B5:0.25 C6:0.25 | ' +
        'D6:0.25 C6:0.25 B5:0.25 D6:0.25 C6:0.5 -:0.5 | ' +
        'B5:0.5 -:0.5 B5:0.5 -:0.5 | D6:0.25 -:0.25 C6:0.5 -:0.5 B5:0.75 -:0.25 | ' +
        'A5:0.5 -:0.5 G#5:0.25 A5:0.25 | B5:0.25 A5:0.25 G#5:0.25 B5:0.25 A5',
    },
  ];

  const api = { SOLFEGE, LETTERS, SONGS, freqToMidi, midiToFreq, noteParts, noteLabel, isBlackKey, parseSong };
  root.WhistleMusic = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
