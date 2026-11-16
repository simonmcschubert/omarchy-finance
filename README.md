# Finance

A personal finance dashboard for [Omarchy](https://omarchy.org/): regular
expenses and income, broker accounts with monthly values and pay-ins, and the
numbers that matter on the way to financial independence (FI). No account and
no sync: everything stays in one file on this computer.

It runs as an Omarchy web app: a small local server and a "Finance" window
in the app launcher. Colors follow the current Omarchy theme; the charts
keep colors of their own, so that their lines stay apart in every theme.

![Dashboard](docs/dashboard.png)

## Install

Needs Omarchy (tested with 4.5.0), Python 3.11 or newer, and Chromium
(Omarchy's default browser).

```bash
git clone https://github.com/simonmcschubert/omarchy-finance.git ~/.local/share/omarchy-finance
~/.local/share/omarchy-finance/setup
```

`setup` adds a user service (`omarchy-finance.service`) that runs the server
at login on `http://127.0.0.1:47219/`, and a "Finance" entry in the app
launcher (`Super+Space`). The server reads the code from the cloned
directory, so keep it where it is.

## Update

Finance looks for a new release 15 seconds after its server starts and every
four hours. The update button, a circle of arrows at the right end of the top
bar, checks now when clicked; hover it to see the installed version. When
there is a release, the button turns into a down arrow with **Update**. Click
it to download the release, then click **Restart to update** to install it:
Finance restarts its server with the release and reloads the window. When the
new server does not answer, Finance goes back to the version it had. A
notification confirms the update or says why it failed. When it fails before
the restart (local changes in the checkout, for example), the button says
**Update failed** and why, when hovered. Like `git pull`, this does not show
the changes first; the release notes on GitHub list them. Updates never touch
the data.

![The update button: check, Update, Restart to update, Updating, Up to date](docs/update.png)

Settings › Updates chooses which updates the button offers. **Stable**, the
default, offers releases. **Preview** offers every change on `main` as soon
as CI has passed for it, days or weeks before it is released: new features
first, and now and then a new bug. A preview is named by its commit, such as
`preview 1a2b3c4`, and the installed version then reads `0.2.0-3-g1a2b3c4`:
three commits past 0.2.0. Previews have no release notes; the commits on
GitHub list the changes. Back on Stable, Finance keeps the version it has
until a release is newer. It never goes back to an older version, which
could not read data saved by a newer one.

![Settings › Updates: Stable or Preview](docs/update-channel.png)

Looking for updates asks the repository Finance was cloned from (GitHub) for
its tags, and on Preview for its `preview` branch. Nothing about the data is
sent.

The same from a terminal:

```bash
~/.local/share/omarchy-finance/update check
~/.local/share/omarchy-finance/update install 0.2.0
~/.local/share/omarchy-finance/update channel preview   # or stable
```

`git -C ~/.local/share/omarchy-finance pull && ~/.local/share/omarchy-finance/setup`
works too, and is how a copy installed before the update button gets it. It
takes the newest commit on `main`, released or not. Run `setup` again after
an update when the release notes say so, for changes to the service or the
launcher entry.

## Remove

```bash
~/.local/share/omarchy-finance/setup --remove
rm -rf ~/.local/share/omarchy-finance
```

The data file stays.

## Use

- **Expenses** and **Income**: regular payments with a name, a category, an
  amount, and how often they are paid, in months (1 monthly, 3 quarterly,
  12 yearly, 24 every two years, or any other number up to 120). Enter income
  after tax. Only current amounts: when the rent goes up, edit it and the
  numbers change. **Deactivate** sets an expense inactive: it stays in the
  list, under Inactive, but counts nowhere (not in the totals, the FI number
  or the charts) until **Activate** counts it again. New expenses are active.
  **Essential** marks an expense you would pay even on the leanest budget
  (rent, food, insurance): those count for Lean FI as well. New expenses are
  not essential.

  Each one **starts** now, at retirement, at an age or in a month, and
  **ends** never, at retirement, at an age or after a month: childcare from
  August 2027 until July 2031, health insurance from retirement until 67, a
  state pension from 67, a salary until retirement. Ages and retirement
  start in January of their year. It counts only in its months: what does
  not count this month is listed under Later or Ended, and is left out of
  the totals. New income ends at retirement; new expenses never end. Income
  from before this setting ends at retirement, as it was never counted after
  it; change that for income that goes on, such as rent from a flat.

  Two helpers, for Germany, add what changes when you stop working:
  - **State pension** (under Income): your Rentenpunkte so far, from the
    Renteninformation, plus those of the years you still plan to work,
    times the value of a point (42,52 € from July 2026), 0,3 % less a month
    before the regular age (your retirement age in Settings; at most 4
    years) or 0,5 % more a month after it, less what pensioners pay for
    health and care insurance (12,95 % by default). Added as the income
    "State pension" from the age it starts, or updates it. The
    Renteninformation's own pension at 67 assumes you pay in until then;
    early retirees get less.
  - **Health and care insurance after you stop working** (under
    Expenses): as a voluntary member of a statutory insurer, at least the
    minimum base (1.318,33 € a month in 2026) × 14 % + the Zusatzbeitrag
    (2,9 % on average) + care insurance (4,2 % without children, 3,6 %
    with): about 280 € a month. Added as the essential expense "Health and
    care insurance" from retirement until the age the pension starts.

  Both numbers can be changed; income tax is left out.
- **Portfolio**: per month, each invested account's value at month end, what
  was paid in that month (negative for withdrawals), and a one-off: a lump
  sum in or out, such as an inheritance or a house deposit. A one-off counts
  as paid in (so it is no gain), but not for the average pay-in that the
  investment rate, Time to FI and the forecast go on with. Cash, property,
  pension assets and debts have only a value: what they are worth, or still
  owed, at month end; the history adds the net worth. An account without a
  value in a month counts with its last value.
- **Forecast**: how the portfolio could grow until retirement, and whether
  it lasts after, in three plans and at three growth rates (6, 8 and 10 % a
  year before inflation, by default). See [Forecast](#forecast).
- **Settings**:
  - Currency (default euro). It only changes how amounts are shown; nothing
    is converted.
  - Number format for amounts and percentages: `1.000.000,00` (default),
    with the currency sign after the amount (`1.234,56 €`), or
    `1,000,000.00`, with it before (`€1,234.56`). Amounts can be typed
    either way. Dates follow the system language.
  - Safe withdrawal rate (default 4 %) and a buffer on expenses for irregular
    costs (default 10 %).
  - Expected return (default 8 %): the portfolio's yearly return before
    inflation, for Time to FI, the Path to FI chart and the forecast.
  - Inflation (default 3 %): how much prices rise a year. Time to FI, the
    Path to FI chart and the forecast raise the expenses and the FI number
    by it, so their amounts are in the money of each year. Pay-ins stay as
    they are: when they rise, so does their 12-month average. Data files
    from before this setting get 3 % inflation and 3 points more expected
    return, so 5 % after inflation becomes 8 % before it.
  - Year of birth and retirement age (default 67), for the forecast. The
    forecast needs the year of birth; it is empty until entered.
  - Emergency fund (default 6): how many months of expenses to keep in
    cash accounts; 0 sets no target.
  - Categories, one list for expenses and one for income. A new data file
    starts with a few common ones. Renaming a category renames it on every
    expense or income that has it; deleting one leaves them without a
    category.
  - Accounts, each with what it holds: **invested** (brokers, ETF savings
    plans: the portfolio), **cash** (Tagesgeld, the emergency fund),
    **property**, **pension assets** (Riester, Rürup, a company pension:
    locked until retirement) or **debt** (what is still owed, such as a
    mortgage). Only invested accounts are the portfolio that the FI number,
    Time to FI and the forecast count; all of them, debts taken off, are the
    net worth. Accounts from before this setting, and new ones from a CSV
    import, are invested. Deleting one deletes its monthly values too.
  - Import past months from CSV, and export all monthly values as CSV.

`Ctrl+1` to `Ctrl+6` open Dashboard, Expenses, Income, Portfolio, Forecast and
Settings.

![Expenses, two of them inactive](docs/expenses.png)

![Portfolio](docs/portfolio.png)

### Dashboard numbers

| Number | How it is calculated |
| --- | --- |
| Monthly income | Sum of the income that counts this month, each divided by its months (a yearly bonus counts one twelfth) |
| Monthly expenses | Sum of the active expenses that count this month the same way, plus the buffer |
| Investment rate | Average monthly pay-in over the last 12 months ÷ monthly income |
| Portfolio | Sum of all accounts in the latest month, and its change since the month before |
| Gains, last 12 months | Change in portfolio value over the last 12 months minus the pay-ins and one-offs. The return is that gain ÷ (the value 12 months ago + each pay-in and one-off for the part of the 12 months it was invested, from the middle of its month) |
| Expenses covered | Portfolio ÷ monthly expenses: how long it would pay for them. Under it, the emergency fund: the latest values of the cash accounts ÷ monthly expenses, and how much is missing to the months set in Settings |
| FI number | What the portfolio would need when retiring now. What it pays a month: the expenses that count then, plus the buffer, less the income that does. Once nothing starts or ends any more, that amount × 12 ÷ withdrawal rate (× 25 at 4 %); until then, what it pays on top of that, month by month, such as bridging the years until a pension starts. Never more than the highest monthly amount × 12 ÷ withdrawal rate. Without starts and ends: monthly expenses × 12 ÷ withdrawal rate |
| FI reached | Portfolio ÷ FI number |
| Time to FI | Months until the portfolio reaches the FI number of that month (for retiring then): from the latest month it grows by the expected return (compounded monthly) and gets the average monthly pay-in each month, while the FI number rises by the inflation. Years from two years on; nothing beyond 100 years |
| Lean FI | The same three for the essential expenses only, with the buffer: the FI number for a lean budget, how much of it the portfolio reaches, and in how long. Shown under the FI numbers once an active expense is essential; the bar under FI reached marks it |

With less than 12 months of history, the average uses the months there
are, and so do the gains, from the first month on.

When last month has no values yet, the Portfolio tile says so ("Okt. 2026
not entered yet", or how many months are missing) and links to the first
month without values.

The **Portfolio** chart has two views; the one picked last stays picked.

- **History**: the portfolio value and what was paid in, per month. Paid in
  starts with what each account held in its first month, then adds its
  pay-ins, so the space between the lines is the gain (green) or loss (red)
  since then. Hovering a month shows the gain in money and percent, and how
  much of that month's change was paid in and how much came from the market.
  The FI number shows once the data reaches it.
- **Path to FI** (needs active expenses): from the latest month, the value
  goes on growing the way Time to FI counts, as a dashed line until it
  reaches the FI number, with a band from 2 points below to 2 points above
  the expected return (6 % to 10 % at 8 %), also up to the FI number. From the latest month on, the
  FI number rises by the inflation. The line under the chart says when each
  reaches the FI number, and what the FI number is by then.

![Path to FI](docs/path-to-fi.png)

**Net worth**, once there is an account that is not invested, adds up the
latest value of every account, debts taken off, with each kind on a bar,
and its change since the month before (left out in a month an account is
entered for the first time).

**Where the income goes** splits the monthly income into expenses (with
the buffer), the average monthly pay-in of the last 12 months, and what is
left over, or says how much more than the income those two take.
**Expenses by category** shows the expenses without the buffer.

### Forecast

![Forecast](docs/forecast.png)

Three plans, each investing the same amount a month until it changes
course (the amount starts as the average pay-in of the last 12 months, and
can be changed, to 0 too). A tile for each answers its question:

| Plan | Invests | Its tile says |
| --- | --- | --- |
| Keep investing | until retirement | what the portfolio is worth when retirement starts |
| Coast | until Coast FI, then only the amount set for after it (default 0) | when Coast FI is |
| Retire early | until the portfolio reaches the FI number, then lives off it | when that is |

Retirement starts in January of the year you reach the retirement age; for
Retire early, the month after it reaches the FI number. From then on every
plan lives off the portfolio: each month it takes out the expenses that
count that month (with the buffer), less the income that does, risen by the
inflation. Expenses and income that start or end at retirement follow each
plan's retirement. Coast FI is the first month from which investing only the
amount for after it makes the portfolio reach the FI number when
retirement starts; with 0, it gets there on its own. The page says what the
portfolio pays when retirement starts, and the tiles what the FI number is.

Each tile also says whether the money lasts, that is whether some is still
left at age 150, or at which age it runs out. When it lasts but would run
out at the lowest growth rate, the tile says that too.

The growth rates are the expected return from Settings and 2 points less
and more, as on the Path to FI chart; the buttons at the top switch the
tiles and the chart between them. The chart shows the three plans up to age
95, in the colors of their tiles, with the FI number and retirement. Coast
and Retire early follow Keep investing's line until a dot where they change
course.

- It starts from the portfolio in the latest month, and grows it by the
  growth rate every month (8 % a year is about 0.64 % a month), as Time to
  FI on the dashboard does.
- Every amount is in the money of its year: growth is before inflation, and
  the expenses and the FI number rise by the inflation from Settings (3 % a
  year by default). What is invested stays the same.
- The growth is the same every year. Real markets are not, and bad years
  right after you start living off the portfolio hurt most.
- A state pension or other income that goes on after retirement counts
  when it is entered under Income, from its age, and the FI number covers
  the years until it starts. Taxes are left out.

**Planned one-offs**, at the bottom of the page, are money that comes in
or goes out once in a month to come: an inheritance, a house deposit, a
car, a sabbatical (what you live on then, and the pay-ins you skip). Every
plan gets them in their month, as do Time to FI and the Path to FI chart;
Coast FI counts on those still to come before retirement. Amounts are in
today's money and rise with inflation, like expenses. They are saved; a
one-off that has happened goes under Portfolio.

The amounts typed on the page are not saved; the year of birth and the
retirement age are in Settings.

### Importing past months

Settings → **Import past months from CSV**: choose a file or paste rows
copied from a spreadsheet. One row per account and month:

```csv
date;account;value;pay_in;one_off
31.01.2025;Trade Republic;12.345,67;500;0
31.01.2025;ING;58.000;0;50.000
```

- Semicolons, commas or tabs between columns.
- Dates as `2025-01-31`, `2025.01.31` or `31.01.2025`. A row counts for the
  month of its date, so an account can have only one row per month.
- Amounts like `1.234,56` or `1,234.56`. A separator followed by exactly three
  digits is a thousands separator: `1.234` is 1234.
- `pay_in` and `one_off` are optional; empty means 0.
- `kind` is optional: what a new account holds (`invested`, `cash`,
  `property`, `pension` or `debt`; empty means invested). Accounts that
  exist keep their own.
- New account names become new accounts. A row for a month and account that
  already exist replaces the old values.

Check shows what will happen. Nothing is imported while any line has a
problem.

### Exporting

Settings → **Export CSV** saves every monthly value to
`finance-portfolio-<date>.csv` in the same columns, so the import reads it
back. Each row's date is the last day of its month. Amounts have two
decimals. Where the system language writes a decimal comma (German, for
example) the file uses decimal commas and semicolons between columns, as
spreadsheets there expect; otherwise decimal points and commas. The number
format in Settings does not change this.

## Data file

`~/.local/state/omarchy-finance/finance.json`, in a directory only the owner
can open. Copy it to back it up. Amounts are stored in cents (hundredths of
the currency). Files from older versions of Finance are upgraded on the
first change; those versions cannot read them after that.

Before the first change of each day, Finance keeps a copy of the file as it
was, as `backups/finance-<date>.json` next to it (for example
`finance-2026-11-16.json`), and keeps the copies of the last 30 days with
changes. A bad import or a slip can be undone by copying that day's file
over `finance.json`; open windows show it once they get focus. Settings ›
Data file shows where the copies are. A copy that cannot be written is
logged, and the change is still saved.

If the file cannot be read, Finance shows an error and saves nothing until the
file is fixed or moved away. When two Finance windows are open, a save from a
window with old data is refused and that window reloads.

## Security

The server listens on `127.0.0.1` only. It answers only requests addressed to
`127.0.0.1:47219` or `localhost:47219` and refuses writes from other web
pages, so a website open in the browser cannot read or change the data. Other
programs running as the same user can, as with any file in the home
directory.

## Development

```text
server.py          # local server: page, /api/data (load/save), /api/update, /theme.css
app/
├── index.html
├── app.mjs        # the views; saves every change
├── finance.mjs    # data format, parsing, metrics, forecast, CSV import and export (no DOM)
├── chart.mjs      # portfolio and forecast charts (SVG)
├── update.mjs     # the update button, and the channel in Settings
└── style.css
setup              # user service and launcher entry; --remove undoes
update             # finds, downloads and installs releases or previews
```

Run it without installing, with its own data file:

```bash
./server.py --port 8123 --data /tmp/finance-dev.json
```

Tests:

```bash
node --test                               # finance.mjs, update.mjs, update
python3 -m unittest discover -s test      # server.py
```

The tests of `update` run it against real git repositories, with stand-ins
for `systemctl` and `curl`. A server started this way offers updates too,
but `update install` refuses a checkout that `omarchy-finance.service` does
not run, so installing one fails there.

## Releases

Actions › Release › Run workflow, with patch, minor, or major; the first
release starts from 0.0.0, so minor gives 0.1.0. The workflow tags the `main`
commit that passed CI as `vX.Y.Z` and creates the GitHub Release with notes
from the merged pull requests. The tags hold the version (`update version`).
Installed copies offer the release within four hours. "Release candidate"
publishes `vX.Y.Z-rc.N`, which they do not offer, and "Dry run" shows the
version and notes without publishing.

Previews need no step: once CI passes for a commit pushed to `main`, the
Preview workflow fast-forwards the `preview` branch to it, and copies on
Preview offer it within four hours.
