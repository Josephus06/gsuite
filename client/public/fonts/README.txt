Knockout HTF49-Liteweight -- the assigned Job Order clock.

Drop the licensed file here under ONE of these exact names (lower case):

    knockout-htf49-liteweight.woff2     <- preferred
    knockout-htf49-liteweight.woff
    knockout-htf49-liteweight.otf
    knockout-htf49-liteweight.ttf

client/src/styles/clock-font.css lists all four, so whichever you have works
without converting it. woff2 is worth producing from a desktop OTF if you can:
roughly 40% of the size over the wire, and this loads on every page for the
artists who have a timer running.

Until a file is here the clock falls back to the app's display face and nothing
breaks -- the @font-face simply finds nothing and the stack moves on.

NOT COMMITTED BY DEFAULT. Knockout is licensed from Hoefler&Co and a webfont
licence usually covers named domains, not redistribution. Check the licence
before adding the file to git; if it may not be committed, it has to be copied
onto each install by hand (droplet, office, Railway) and that is worth writing
down somewhere the next person will look.
