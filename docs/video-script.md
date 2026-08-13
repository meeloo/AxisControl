# Axis Control — video script

Target: **6–7 minutes**. One take per section, screen recording with voice over,
cut between sections. The machine should be powered and connected throughout —
every number on screen should be real, because the whole pitch is that this
tells you the truth about your machine and a faked demo undercuts that on the
first frame.

Record at 1920×1080. The app at 100% zoom is small on a 1080p capture; run the
browser at 125% and lay out two or three panels per page rather than filling the
screen with panels nobody is looking at.

**Before recording:** run a real job at least once so `Toolpath` has something
to track, and make sure the configuration has at least one genuine finding. If
the checker says "Nothing looks contradictory", section 3 has nothing to show —
either record on a machine that has something, or plant a duplicate `M203` in a
test config and say plainly that it is planted.

---

## 0 · Cold open — 0:00–0:20

*No talking over the first five seconds. Screen recording, Configuration panel,
already filtered to* **Problems**.

> This is my CNC controller's configuration file. It has been running fine for
> two years.

*Beat. Point at the findings.*

> It sets the maximum speed twice, so the first one does nothing. It configures
> the steps per millimetre before the axes exist, so that line is thrown away at
> boot. And it has a parameter for an axis this machine does not have.
>
> The firmware never said a word about any of it.

*Title card: Axis Control.*

---

## 1 · What this is, and what it is not — 0:20–1:00

*Cut to the Control page: DRO, jog rose, tool.*

> Axis Control is a web front end for Duet and RepRapFirmware controllers, built
> for routers and mills rather than printers.
>
> Duet Web Control is an excellent 3D printer interface, and that is exactly the
> problem. On a router its whole information architecture is shaped around a
> machine doing a different job — you spend your time hunting for work
> coordinates and tool length past a heater graph.

*Show DWC at `/` in another tab, then switch back.*

> This does not replace it. DWC stays installed, firmware updates and network
> setup are still its job, and this contains none of its code — it talks to the
> documented HTTP API. Install it beside DWC and use whichever suits the task.

> It is Apache-2.0, it runs off the controller's own SD card, and it needs no
> server, no proxy and no internet.

---

## 2 · The layout — 1:00–1:30

*Drag a panel. Add a page. Split.*

> Everything is a panel and you arrange them yourself, onto as many pages as you
> want. Mine has a Control page for setup, a Job page for watching a program
> run, and an Advanced page I only open when something needs fixing.

*Switch pages to show it.*

> Each page and each panel remembers its own state — the Files panel on one page
> can sit in `/gcodes` while the one on another sits in `/sys`.

---

## 3 · The configuration panel — 1:30–3:30

**This is the section that sells it. Give it the time.**

*Configuration panel, unfiltered.*

> This reads `config.g`, and everything `config.g` runs — every `M98`, and the
> `M501` into `config-override.g` — in the order the firmware actually runs
> them. Fourteen files on my machine, sixty-four commands.

*Click a command. The reference opens under the line.*

> Click any command and the reference for it opens right there. The whole
> RepRapFirmware G-code dictionary ships inside the app, so this works with the
> machine unplugged from the world.

*Filter to* **Problems**.

> And it says what is wrong. This one is set twice — the second wins and the
> first does nothing, and it tells you which line lost. This one runs before the
> `M584` that creates the axes, so the firmware refuses it at boot. This one has
> a parameter for an axis that does not exist.

*Point at the "in force" and "machine says" badges.*

> Beside every value it shows what the machine is actually running, read live
> from the object model. That is the one that matters most: a line can read
> perfectly and not be in force — overridden by `config-override.g`, replaced by
> a duplicate further down, or changed at the console and never saved. Nothing
> else shows you that.

---

## 4 · Tuning without the restart loop — 3:30–4:45

*Filter to* **Editable**.

> Here is the part that changes how a day goes. You know the loop: edit the
> file, restart, feel it, edit again. Ten minutes to try one number.

*Type a new acceleration. Press* **Try on the machine**.

> Type it, press this, and it is in force. Nothing has been written to the SD
> card — the badge says "applied, not saved". If I hate it, `M999` and it is
> gone.

*Jog the machine so the change is audible. This is worth doing on camera —
the sound of the machine is the proof.*

*Then press* **Save to the file**.

> When the number is one worth keeping, this writes it back into the line it
> came from.

*Open the file in the Files panel, side by side.*

> Look at what changed: those four characters, and nothing else. My alignment
> spaces, my comments, my commented-out previous values — all exactly as they
> were. It re-read the file first and would have refused if anything had changed
> underneath, and it kept a `.bak` before it wrote.

*Optionally: the add box. Type `M203 X5000` where an `M203` already exists and
let the validation refuse it.*

> You can add lines too. It checks what you type in the position it would go —
> a second `M203` that would overwrite the first gets refused before it is
> written, not discovered at the next restart.

---

## 5 · Running a job — 4:45–6:00

*Job page. Load a program. Start it.*

> The toolpath viewer follows the running job by byte offset — the cut part is
> drawn behind the cutter, and the cutter is drawn at its actual diameter.

*Scrub the time slider. Then show run-from-line.*

> Which means when a cutter breaks, you pick the restart point off the drawing.

*Preflight panel.*

> Before it starts, preflight checks the program against this machine: travel,
> tools it asks for that are not in the changer, spindle speeds the VFD cannot
> reach.

*Jog rose.*

> Jogging is a compass rose — direction and distance in one press, and the
> distances are always numbers a person would choose. Ten, five, one, not 12.7.

*Text panel. Type a name, pick Gothic, press Preview.*

> And there is a text panel, which is the one people ask for. Six single-stroke
> engraving faces, no CAM step — type it, see it, cut it. Labelling a fixture
> used to be twenty minutes through CAD; it is about thirty seconds here.

*Probing panel.*

> Probing keeps tool length, workpiece zero and feature finding as three
> separate flows, because they are three different jobs and mixing them up is
> how you drive a probe into a vise.

---

## 6 · Close — 6:00–6:40

*Back to the Configuration panel.*

> It is Apache-2.0, on GitHub, and it installs onto the controller's own SD card
> from inside the app itself — there is an Install panel that copies it across
> and tells you when there is a newer version.

*Show the Install panel briefly.*

> Fair warning on two things. This drives machinery that can hurt you: verify
> what you run, keep a hand on the stop, and treat the simulation as a drawing
> rather than a promise. And it is proven on a sample of exactly one — my
> machine. If you run a Duet on a router, I would genuinely like to know what
> breaks.

> Link below. Thanks for watching.

---

## Notes for the edit

- **Do not cut away from the machine while a value is being tried.** The point
  of section 4 is that the change is real and immediate; cutting to a slide
  breaks exactly the claim being made.
- **Show at least one thing refusing.** A demo where everything succeeds is a
  demo of a happy path. The validation refusing a bad line, or a panel greyed
  out because the axis is not homed, is more persuasive than another feature.
- **Do not over-narrate the panel list.** Sections 3 and 4 are the reason
  someone installs this. Everything in section 5 exists in other software in
  some form; the configuration editor does not.
- Keep the total under seven minutes. If it runs long, cut section 2 to fifteen
  seconds and take the Import/Machining panels out entirely — they are the least
  differentiated thing in the app and there is a separate video in them.
- Capture the machine's audio during section 4. A change to acceleration you can
  *hear* is worth thirty seconds of explaining that it took effect.
