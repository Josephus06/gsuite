import { useLayoutEffect, useRef } from 'react';

// A textarea that corrects as you type, the way Word does (asked 2026-10-28 for the Incident
// Report's "What happened"). When a word is finished -- a space, punctuation or Enter is typed:
//   - the first letter of a sentence is capitalized (start of the text, after . ! ? or a new line)
//   - "i" on its own becomes "I" (and i'm, i'll, i've, i'd)
//   - a common misspelling is replaced from AUTOCORRECT ("teh" -> "the", "recieve" -> "receive")
// Anything else misspelled is left to the browser's own spell check (red underline, right-click for
// suggestions), which spellCheck turns on. Only the word just finished is touched -- a correction is
// undone by editing the word back, which is not corrected again until another word ends after it --
// and pasted text is left exactly as pasted.
const AUTOCORRECT = {
  teh: 'the', hte: 'the', taht: 'that', thier: 'their', recieve: 'receive', recieved: 'received',
  beleive: 'believe', belive: 'believe', definately: 'definitely', seperate: 'separate', occured: 'occurred',
  occurence: 'occurrence', untill: 'until', wich: 'which', becuase: 'because', becasue: 'because',
  adn: 'and', nad: 'and', alot: 'a lot', dont: "don't", didnt: "didn't", doesnt: "doesn't", wasnt: "wasn't",
  werent: "weren't", cant: "can't", couldnt: "couldn't", wouldnt: "wouldn't", shouldnt: "shouldn't",
  isnt: "isn't", arent: "aren't", hasnt: "hasn't", havent: "haven't", wont: "won't", im: "I'm", ive: "I've",
  youre: "you're", theyre: "they're", thats: "that's", whats: "what's", lets: "let's",
  goverment: 'government', enviroment: 'environment', managment: 'management', employe: 'employee',
  emplyee: 'employee', empolyee: 'employee', supervsior: 'supervisor', supervisior: 'supervisor',
  manger: 'manager', comapny: 'company', compnay: 'company', tommorow: 'tomorrow', tomorow: 'tomorrow',
  yesterady: 'yesterday', wierd: 'weird', freind: 'friend', truely: 'truly', begining: 'beginning',
  accross: 'across', arguement: 'argument', basicly: 'basically', calender: 'calendar', concious: 'conscious',
  embarass: 'embarrass', existance: 'existence', foward: 'forward', grammer: 'grammar', happend: 'happened',
  happenned: 'happened', immediatly: 'immediately', independant: 'independent', knowlege: 'knowledge',
  neccessary: 'necessary', necesary: 'necessary', noticable: 'noticeable', ocassion: 'occasion',
  persistant: 'persistent', posession: 'possession', prefered: 'preferred', publically: 'publicly',
  realy: 'really', reccomend: 'recommend', recomend: 'recommend', refered: 'referred', relevent: 'relevant',
  responsable: 'responsible', succesful: 'successful', sucessful: 'successful', suprise: 'surprise',
  tounge: 'tongue', wether: 'whether', writen: 'written', absense: 'absence', abscent: 'absent',
  attendence: 'attendance', violaton: 'violation', voilation: 'violation', negligance: 'negligence',
  incedent: 'incident', incidnet: 'incident', reprot: 'report', repot: 'report', wiht: 'with', whit: 'with',
  becaus: 'because', jsut: 'just', konw: 'know', knwo: 'know', woudl: 'would', coudl: 'could', shoudl: 'should',
  ofthe: 'of the', inthe: 'in the', tothe: 'to the', onthe: 'on the',
};
const I_FORMS = { i: 'I', "i'm": "I'm", "i'll": "I'll", "i've": "I've", "i'd": "I'd" };
const ENDS_WORD = /[\s.,!?;:)\]]/;

// The correction for the text just before the caret, whose last character ended a word.
function correct(before) {
  const m = /([A-Za-z']+)([\s.,!?;:)\]])$/.exec(before);
  if (!m) return before;
  const [, word, end] = m;
  let start = before.length - m[0].length;
  const lower = word.toLowerCase();
  let fixed = I_FORMS[lower] || AUTOCORRECT[lower] || word;
  // Keep the writer's capital on a corrected word ("Teh" -> "The").
  if (fixed !== word && /^[A-Z]/.test(word) && !I_FORMS[lower]) fixed = fixed[0].toUpperCase() + fixed.slice(1);
  // Sentence start: nothing before it, or only spaces after . ! ? or a line break.
  const prior = before.slice(0, start);
  if (/(^|[.!?]\s+|\n\s*)$/.test(prior) && /^[a-z]/.test(fixed)) fixed = fixed[0].toUpperCase() + fixed.slice(1);
  if (fixed === word) return before;
  return prior + fixed + end;
}

export default function AutoCorrectTextarea({ value, onChange, ...rest }) {
  const ref = useRef(null);
  // Where the caret goes after a correction -- put there in the same render that writes the corrected
  // text, before the next keystroke can land (a frame later, fast typing went in the wrong place).
  const caretAfter = useRef(null);
  useLayoutEffect(() => {
    if (caretAfter.current != null && ref.current) {
      ref.current.setSelectionRange(caretAfter.current, caretAfter.current);
      caretAfter.current = null;
    }
  });
  function handle(e) {
    const el = e.target;
    const text = el.value;
    const caret = el.selectionStart;
    const typed = e.nativeEvent?.inputType;
    // Only on typing (not paste or undo), and only when the character just typed ends a word.
    if ((typed === 'insertText' || typed === 'insertLineBreak') && caret > 0 && caret === el.selectionEnd && ENDS_WORD.test(text[caret - 1])) {
      const before = text.slice(0, caret);
      const after = text.slice(caret);
      const fixed = correct(before);
      if (fixed !== before) {
        caretAfter.current = fixed.length;
        onChange({ ...e, target: { ...el, value: fixed + after } });
        return;
      }
    }
    onChange(e);
  }
  return <textarea ref={ref} spellCheck lang="en" autoCapitalize="sentences" value={value} onChange={handle} {...rest} />;
}
