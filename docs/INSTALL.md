# Installing the Simpro assistant on your PC

This guide sets up Claude on your computer so you can ask it about your Simpro jobs, quotes, invoices, schedules and customers in plain English. It works on Windows and Mac. Where the steps differ, both are shown.

**Time needed:** about 30 minutes, once.

**You'll need:**

- A Windows or Mac computer you can install programs on.
- A Claude account (a paid plan works best).
- Admin access to Simpro, or someone who has it, for Step 4.
- The invite to the GitHub project.

---

## Step 1: Accept the GitHub invite

1. Open the GitHub invite email, or go to **github.com** and sign in. Create a free account if you don't have one.
2. Click **Accept invitation**. You should now be able to open **github.com/ladleykullum/Simpro_MCP**.

## Step 2: Install the programs

Install these two programs. For both, accept all the installer's default options.

1. **Node.js**: go to **nodejs.org** and download the version marked **LTS**. Run the installer.
2. **Claude Desktop**: go to **claude.ai/download**, install it, and sign in with your Claude account.

To check Node.js installed, open a terminal:

- **Windows:** press the Windows key, type `cmd`, and press Enter.
- **Mac:** press Cmd + Space, type `Terminal`, and press Enter.

Then type this and press Enter:

```
node --version
```

It should show a version number such as `v22.x.x`. If it says "not recognized" or "command not found", restart your computer and try again.

## Step 3: Download the project

1. Go to **github.com/ladleykullum/Simpro_MCP**.
2. Click the green **Code** button, then **Download ZIP**.
3. Unzip it, rename the folder to **`SimproMCP`**, and move it to a simple location:
   - **Windows:** `C:\SimproMCP`, so that the file `C:\SimproMCP\package.json` exists.
   - **Mac:** your home folder, so that `/Users/<your name>/SimproMCP/package.json` exists.

> Use exactly these names and places. The later steps rely on them.

## Step 4: Create a Simpro sign-in app

This lets the assistant sign in to Simpro as you. It needs a Simpro admin.

1. In Simpro, go to **Setup → Integrations → API** and create a new app or key.
2. Choose the **Authorization Code** (OAuth) type.
3. Set the **Redirect URI** to exactly:

   ```
   http://localhost:8237/callback
   ```

4. Save it, then copy these somewhere safe:
   - **Client ID**
   - **Client secret** (treat it like a password)
5. Also note:
   - **Your Simpro address:** what you type to log in, for example `https://yourcompany.simprosuite.com`. Note only the part up to `.com`.
   - **Company ID:** almost always `0`.

## Step 5: Build the project

Open a terminal in the project folder:

- **Windows:** open `C:\SimproMCP` in File Explorer, click in the address bar at the top, type `cmd`, and press Enter.
- **Mac:** open Terminal, type `cd ~/SimproMCP`, and press Enter.

Run these two commands, one at a time. Each takes a minute or two.

```
npm ci
```

```
npm run build
```

Warnings in yellow are fine. Red **ERR!** lines are not; see Troubleshooting below.

## Step 6: Enter your Simpro details

In the same terminal, create your settings file and open it:

- **Windows:**

  ```
  copy .env.example .env
  ```

  ```
  notepad .env
  ```

- **Mac:**

  ```
  cp .env.example .env
  ```

  ```
  open -e .env
  ```

Fill in these lines, leaving no spaces around the `=`:

```
SIMPRO_BASE_URL=https://yourcompany.simprosuite.com
SIMPRO_COMPANY_ID=0
SIMPRO_CLIENT_ID=paste-your-client-id
SIMPRO_CLIENT_SECRET=paste-your-client-secret
SIMPRO_WRITE_MODE=confirm
SIMPRO_ALLOW_DELETE=false
```

Save and close the file.

> Keep this file private. Never email it or upload it anywhere.

## Step 7: Sign in to Simpro

In the same terminal, run:

```
npm run login
```

A browser tab opens at the Simpro login page. Sign in and approve access. When it says **"✓ Signed in to Simpro"**, close the tab. The terminal should say `Signed in.`

You only do this once. The login is saved in the project folder.

## Step 8: Connect it to Claude Desktop

1. Open **Claude Desktop** and go to **Settings → Developer → Edit Config**. A file called `claude_desktop_config.json` opens, or its folder does; open the file with Notepad or TextEdit.
2. Replace everything in the file with the version for your computer.

   **Windows:**

   ```json
   {
     "mcpServers": {
       "simpro": {
         "command": "node",
         "args": ["C:\\SimproMCP\\dist\\index.js"]
       }
     }
   }
   ```

   **Mac:** replace `yourname` with your Mac username. Run `whoami` in Terminal if you're not sure what it is.

   ```json
   {
     "mcpServers": {
       "simpro": {
         "command": "node",
         "args": ["/Users/yourname/SimproMCP/dist/index.js"]
       }
     }
   }
   ```

   > If the file already had other servers in it, add the `"simpro": { ... }` block inside the existing `"mcpServers"` section instead of replacing everything.

3. Save the file.
4. **Quit Claude Desktop completely and reopen it.** Closing the window is not enough:
   - **Windows:** right-click the Claude icon near the clock and choose **Quit**.
   - **Mac:** press Cmd + Q.

## Step 9: Try it

Start a new chat in Claude Desktop. Click the tools/connectors button below the message box. You should see **simpro** listed with its tools.

Ask something like:

- "What jobs are in progress?"
- "Who's booked on what this week?"
- "Which invoices are overdue?"
- "Show me open quotes over $5,000."
- "Give me an overview of [customer name]."

**When Claude wants to change something in Simpro** (for example, add a note to a job), it first shows you exactly what it will do and asks for your OK. Nothing changes until you say yes. Deleting is switched off.

---

## Troubleshooting

| Problem | Fix |
|---|---|
| `node` is "not recognized" / "command not found" | Restart the computer after installing Node.js. If it still fails, reinstall Node.js from nodejs.org. |
| `npm ci` shows red ERR! lines | Make sure the terminal is in the SimproMCP folder (`package.json` must be there). Check your internet connection and try again. |
| Claude Desktop doesn't show "simpro" | Check the config file for typos: every `"` and `,` matters, and Windows paths need double backslashes `\\`. Then fully quit and reopen Claude Desktop. |
| Claude says "spawn node ENOENT" or the server failed to start | Replace `"node"` in the config with the full path. On Windows that's `"C:\\Program Files\\nodejs\\node.exe"`; on Mac it's `"/usr/local/bin/node"`. |
| "SIMPRO_BASE_URL is required" or similar | The `.env` file is missing or not in the SimproMCP folder. Redo Step 6. On Windows, check it isn't named `.env.txt`. |
| The Simpro login page shows an error about the redirect | The Redirect URI in Simpro must be exactly `http://localhost:8237/callback`. |
| "Not signed in" or "HTTP 401" | Run `npm run login` again (Step 7). |
| "HTTP 403" | Your Simpro user doesn't have permission for that area. Ask your Simpro admin. |
| "currently locked by …" | Someone has that job or quote open in Simpro. Ask them to close it, then try again. |

Claude Desktop's server logs are under **Settings → Developer**. Send them to whoever set this up if you're stuck. Don't send your `.env` file.

## Getting updates

1. Download the new ZIP from GitHub (Step 3) and unzip it.
2. Copy everything **except** your `.env` and `.simpro-tokens.json` files over the old `SimproMCP` folder.
3. In a terminal in the folder, run `npm ci`, then `npm run build`.
4. Fully quit and reopen Claude Desktop.

## Keeping it safe

- `.env` and `.simpro-tokens.json` let anyone act in Simpro as you. Keep them on your computer only.
- If your computer is lost, or you think these files were shared, delete or reset the app in **Simpro → Setup → Integrations → API**. Then create a new one and redo Steps 6–7.
- The assistant can only do what your Simpro user is allowed to do.
