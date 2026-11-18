// A manual monotonic clock for the timer engine: Now() returns the current
// value; Advance(ms) moves it on.
function FakeClock(Start = 1000) {
  let Value = Start;
  const Now = () => Value;
  Now.Advance = (Ms) => {
    Value += Ms;
    return Value;
  };
  Now.Set = (Ms) => {
    Value = Ms;
    return Value;
  };
  return Now;
}

module.exports = { FakeClock };
