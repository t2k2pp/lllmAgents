/** PTYの対話入力を端末のEnter（CR）で確定する。LFはアプリではCtrl+Jになる。 */
export function submitPtyLine(line) {
  return `${line}\r`;
}
