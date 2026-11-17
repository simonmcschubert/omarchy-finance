# Finance: domain language

The words the app, the code and reviews use for the same things. Amounts are
in cents, a month, unless a term says otherwise.

## Money in and out

**Expense** and **Income**: a regular payment, an amount every 1 to 120
months. Its _monthly amount_ is the amount ÷ those months (`monthlyAmount`).
_Avoid_: cost, bill, salary for income in general.

**Starts** and **Ends**: when an expense or income counts. A start is now, at
retirement, at an age or in a month. An end is never, at retirement, at an
age or after a month. Ages and retirement mean January of their year.

**Essential**: an expense needed even on the leanest budget. The essential
expenses make up Lean FI.

**Inactive**: an expense switched off. It stays in the list but counts
nowhere. Income is never inactive.

**Buffer**: a percentage added on top of the expenses, for what the list
misses.

**Retirement month**: January of the year of the retirement age
(`retirementIndex`). Without a year of birth, retirement and ages are never
reached. Retire early moves it to the month after FI.

**Budget** (`budget()`): what counts in one month, for a given retirement
month.
- Each expense and income is _now_ (it counts), _later_ (it starts after),
  _ended_ or _inactive_.
- The budget also gives the monthly totals, with the buffer and the
  essential part, and the need.
- `needIn` is its fast form for the projections' loops.

**Need**: what the portfolio pays a month once retired: the expenses with
the buffer, less the income that counts then, never below 0.

## Portfolio

**Portfolio**: the latest values of the invested accounts. Cash, property,
pension and debt accounts count only for **net worth**.

**Pay-in**: what is paid into the invested accounts in a month. The
**average pay-in** covers the last 12 months, or fewer with a shorter
history. A negative average is a _withdrawal_.

**Future pay-in** (`futurePayIn`): what is paid in a month from now on, for
the investment rate and every projection. It is the average pay-in, or an
amount of your own set in Settings.

**One-off**: money paid in or out once, such as an inheritance or a house
deposit. It is either recorded with a month's values or planned for a
coming month. One-offs count as paid in, but never for the average pay-in.

**Emergency fund**: the cash accounts, in months of expenses.

## FI

**Withdrawal rate**: the share of the portfolio taken out a year. Its
**multiple** is 100 ÷ the rate, so 4 % gives 25 × the yearly need.

**FI number**: what the portfolio needs to retire in a given month
(`fiNumberIn`). It is the need from the last change on × 12 × the multiple,
plus the **bridge**. The bridge is the need above that until the last
change, such as the years before a pension starts.

**FI**: the portfolio reaches the FI number. **Time to FI** is the months
until then.

**Lean FI**: FI for the essential expenses only.

**Coast FI**: from then on, the portfolio reaches the FI number by the
retirement month without any more pay-ins (or with only the coast amount
the Forecast takes). The **Coast FI number** is what the portfolio needs
for that today.

**Milestones**: Coast FI, Lean FI and FI on the dashboard, in the order the
portfolio reaches them.

## Projections

**Expected return**: a yearly percentage, before inflation. The _low_ and
_high_ projections use 2 points less and more (`RETURN_SPREAD`).

**Money of each month**: amounts as they will be then, with expenses and the
FI number rising with inflation and pay-ins staying the same. **Today's
money**: the same amounts with inflation taken out again.

**Plans** (the Forecast page):
- _Keep investing_ pays in until retirement.
- _Coast_ pays in until Coast FI, then only the coast amount.
- _Retire early_ pays in until FI and lives off the portfolio from the month
  after.
