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
reached. Retire at FI moves it to the month after FI.

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

**Future pay-in** (`futurePayIn`): what is paid in a month from now on
(_Now_ in Settings). It is the average pay-in, or an amount of your own.

**Pay-in change** (`payInChanges`): what is paid in a month from a month or
an age on, until the next change: an amount, or the average pay-in. A
change that has started is what is paid in now. The **pay-in plan**
(`payInPlan()`) is the future pay-in and the changes, month by month, for
the investment rate and every projection.

**Rising pay-ins** (`payInsRiseWithInflation`, off by default): pay-ins are
in today's money and rise with inflation in the projections, like expenses.
Off, they stay the same amount of money for good.

**Coast pay-in** (`coastPayIn`, 0 by default): what the Coast plan (Stop
investing) still pays in a month once Coast FI is reached. It stays the
same amount of money, also with rising pay-ins.

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

**FI**: the portfolio reaches the FI number. It counts at the end of the
first month in which the portfolio reaches the FI number of retiring the
month after, and only before retirement. **Time to FI** is the months until
then.

**Lean FI**: FI for the essential expenses only.

**Coast FI**: from then on, the portfolio reaches the FI number by the
retirement month without any more pay-ins (or, in the Forecast, with only
the coast pay-in), after the planned one-offs that take money out. The
**Coast FI number** is what the portfolio needs for that today. Pay-ins to
come, planned or one-off, never lower it: they only make the portfolio
reach it sooner.

**Milestones**: Coast FI, Lean FI and FI on the dashboard, in the order the
portfolio reaches them. Coast FI here never counts the coast pay-in.

**FI outlook** (`fiOutlook()`): where the portfolio goes from the latest
month on. Every FI date the app shows comes from it: the milestones, the
Path to FI chart and the Forecast's plans. It invests the pay-in plan
(0 when it is a withdrawal), adds the planned one-offs, and runs
`forecast()`.

## Projections

**Expected return**: a yearly percentage, before inflation. The _low_ and
_high_ projections use 2 points less and more (`RETURN_SPREAD`).

**Money of each month**: amounts as they will be then, with expenses and the
FI number rising with inflation, and pay-ins staying the same unless they
rise. **Today's money**: the same amounts with inflation taken out again.

Today's money is the default; the choice is kept in the browser.

**Plans** (the Forecast page, `fiOutlook().plans()`), each the answer to
“When can you stop?” on a card of its own:
- _Coast_ (“Stop investing · now”) pays in until Coast FI, then only the
  coast pay-in until retirement.
- _Retire at FI_ (“Stop working · 53”) pays in until FI and lives off the
  portfolio from the month after.
- _Safe_ (“Even at 6 % · 56”), only when Retire at FI runs out at the low
  growth: stops working in January of the first age before retirement from
  which the money lasts even then; none when no age does.
- _Work to 67_ (“At the latest · 67”, the retirement age) pays in until
  retirement. Its **spare** is how much more the portfolio could pay a
  month from then (today's money, in steps of 10) and still last at the
  low growth.

The low and high growth run each plan with the dates of the expected
return, so they show what happens to the same plan. A plan **lasts** when
money is left at the end of age 120 (`SHOWN_AGE`), where the forecast ends.

**Phases**: _Investing_, _Coasting_ and _Retired_. A pension or other
income that starts, or an expense that ends, is a _step_ inside Retired,
never a phase: what the portfolio pays a month changes there, and the
**share** is the part of the spending it pays, the rest coming from income.
