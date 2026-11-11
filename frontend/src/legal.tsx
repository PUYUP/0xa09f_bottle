export function TermsContent() {
  return (
    <>
      <h2>Terms of Service</h2>
      <p>
        a09f is an anonymous, end-to-end encrypted "message in a bottle" relay.
        By using it you agree to these terms.
      </p>

      <h3>1. The service</h3>
      <p>
        You can cast encrypted messages ("casts") into a shared pool and catch
        messages addressed to keys you control. All message content is encrypted
        on your device with AES-256-GCM; the server never sees plaintext or
        private keys.
      </p>

      <h3>2. Acceptable use</h3>
      <p>You agree not to use a09f to:</p>
      <ul>
        <li>send illegal content, harassment, hate speech, or CSAM;</li>
        <li>attempt to break, probe, or overload the relay;</li>
        <li>impersonate others or circumvent blocks;</li>
        <li>scrape or bulk-harvest messages at scale.</li>
      </ul>
      <p>
        We provide block and report tools. Repeated abuse may lead to IP-level
        rate limiting or bans.
      </p>

      <h3>3. No guarantee of delivery</h3>
      <p>
        Casts are ephemeral: pool keys expire, bottles time out, and a cast may
        simply never be caught. We do not guarantee delivery, uptime, or
        persistence of any message.
      </p>

      <h3>4. Your keys, your responsibility</h3>
      <p>
        Private keys live only on your device. If you lose them — or clear
        app data without exporting your secret key — your messages become
        permanently unreadable. We cannot recover them.
      </p>
      <p>
        The same applies if your keys are <strong>stolen or exposed</strong>.
        Because every message addressed to your keys can be decrypted by
        whoever holds them, a compromised key can unlock your entire message
        history — past and future. Treat your secret key export and device access
        like a PIN or a house key: whoever holds it holds your mailbox. We
        cannot detect, prevent, or undo access by someone who legitimately
        possesses your keys, and we are not responsible for losses arising
        from key compromise caused by you or your device.
      </p>

      <h3>5. Disclaimer</h3>
      <p>
        The service is provided "as is" without warranties of any kind. To the
        maximum extent permitted by law, we are not liable for lost messages,
        intercepted keys, or damages arising from use of the service.
      </p>

      <h3>6. Subscription & billing</h3>
      <p>
        A free trial is provided for a limited period. Continued use after
        the trial requires a paid subscription. Payments are processed by
        Polar.sh as merchant of record — we never see or store your card,
        email, or billing details. The only identifier exchanged with Polar
        is your anonymous identity id (derived from your public key), which
        cannot be reversed to identify you.
      </p>

      <h3>7. Changes</h3>
      <p>
        These terms may be updated. Continued use after changes constitutes
        acceptance.
      </p>
    </>
  );
}

export function HowItWorksContent() {
  return (
    <>
      <h2>How a09f works</h2>
      <p>
        a09f is a messaging service shaped like fishing: before you can receive
        anything, you throw bait — a public key — into a shared ocean and wait
        for a bite. You can also cast encrypted messages into the same water,
        hoping a stranger's bait hooks them. The twist is that every message is
        locked with a padlock that only the intended reader owns — the service
        itself is just the courier and never holds the key.
      </p>

      <h3>The one big idea</h3>
      <p>
        Normally, a messaging server must be able to read your messages to
        deliver them. a09f flips this: your device encrypts each message
        <em> before it is sent</em>, and only the recipient's device can undo
        the encryption. The server stores and forwards only scrambled
        ciphertext — it is mathematically unable to read what you wrote, and
        it never possesses anyone's private key.
      </p>

      <h3>1. Your device makes keys — and keeps them</h3>
      <p>
        The moment you open the app, your device generates a pair of digital
        keys: a <strong>public key</strong> (safe to share — it only locks
        things) and a <strong>private key</strong> (the only thing that can
        unlock them). The private key is generated inside your browser or
        phone and stored only there. It is never sent anywhere — not to the
        server, not to us, not to anyone.
      </p>
      <p>
        Think of it like a mailbox: the public key is the slot you publish so
        strangers can drop letters in; the private key is the physical key
        that opens the box. Only you hold it.
      </p>

      <h3>2. Throwing bait — announcing "I am catchable"</h3>
      <p>
        To receive messages, you deposit bait: your device generates fresh
        keypairs and publishes only their <em>public</em> halves into a shared
        pool on the server. Each bait key is like a fishing float — it sits in
        the water advertising "messages may be cast to this spot."
      </p>
      <p>
        The server sees a list of public keys and nothing else. It cannot tell
        which keys belong to the same person, and it cannot read anything
        addressed to them.
      </p>

      <h3>3. Casting a message — sealing the bottle</h3>
      <p>
        When you write a message, your device performs two locks in sequence:
      </p>
      <ul>
        <li>
          <strong>First lock (AES-256-GCM):</strong> the message text is
          encrypted into scrambled ciphertext using a one-time random session
          key. This is military-grade symmetric encryption — the same family
          used for HTTPS and disk encryption.
        </li>
        <li>
          <strong>Second lock (key wrapping):</strong> that session key is
          itself encrypted separately for each intended recipient, using a
          handshake called ECDH (elliptic-curve Diffie–Hellman) on the
          P-256 curve. Each recipient gets their own wrapped copy — like
          putting the same letter into several envelopes, each sealed with a
          different recipient's lock.
        </li>
      </ul>
      <p>
        The result — one ciphertext plus a handful of wrapped keys — is what
        gets sent to the server. Recipients are chosen randomly from the bait
        pool, so even the sender does not fully control who might read it.
        That is the "message in a bottle" part: you cast, the sea decides.
      </p>

      <h3>4. Catching — proving it's yours, then opening</h3>
      <p>
        When a bottle might be addressed to you, the app checks each bait key
        you own. For each candidate, it must prove to the server that it
        actually holds the matching private key — a cryptographic
        proof-of-possession, like showing a passport instead of just stating
        a name. Only then does the server release the bottle to you.
      </p>
      <p>
        Once released, your device reverses the locks entirely on-device: it
        unwraps the session key meant for your bait, then decrypts the
        ciphertext back into readable text. The plaintext never travels over
        the network at any point.
      </p>

      <h3>5. Replies and threads</h3>
      <p>
        Every message can be replied to, forming threads up to 20 levels deep.
        Replies are sealed the same way, addressed to the parent message's
        author through a special deterministic reply key — your device can
        always re-derive the key it needs to read replies on its own messages,
        without storing extra secrets.
      </p>
      <p>
        Your inbox groups replies under their original message, badges threads
        with new activity, and sorts by the most recent reply — similar to how
        a chat app organizes conversations, except nobody knows who is on the
        other end unless they choose to say so.
      </p>

      <h3>6. Usernames — optional, but useful</h3>
      <p>
        The app asks for a username so the community features have someone to
        point at: blocking, reporting, and public profiles. A username is bound
        to your device's identity key — it is not a real-name account, there
        is no email, no password, and no central login. Lose the device without
        a secret key export and the username becomes unreachable forever; that is
        the price of true anonymity.
      </p>
      <p>
        Signing in on a new device works through your <strong>secret key
        export</strong>: an encrypted backup file containing only your private
        keys, protected by a passphrase you choose. Import it and your
        username, bait, and ability to read old messages all come back.
      </p>

      <h3>7. Safety tools — block, report, delete</h3>
      <ul>
        <li>
          <strong>Block</strong> — stops a user from reaching your bait with
          new casts or replies. It is a social filter, not a cryptographic
          wall: a determined anonymous sender can still cast into the pool,
          because anonymity means the server cannot always tell who is casting.
        </li>
        <li>
          <strong>Report</strong> — files a moderation ticket with the bottle
          ID and an optional reason. Reports store only references, never
          plaintext.
        </li>
        <li>
          <strong>Delete</strong> — authors can delete their own messages. The
          server verifies ownership cryptographically, then shreds the
          ciphertext and keeps only an empty tombstone so everyone's apps learn
          the message is gone. Deleting your message does not delete other
          people's replies — they own those.
        </li>
      </ul>

      <h3>8. What the server honestly cannot hide</h3>
      <p>
        Encryption protects <em>content</em>, not <em>existence</em>. The relay
        necessarily sees some things:
      </p>
      <ul>
        <li>That a message was sent, when, and roughly how large it is.</li>
        <li>The shape of conversations — which bottle replied to which — as
          opaque IDs.</li>
        <li>Your IP address, used transiently for rate limiting (use Tor
          Browser if that matters to you).</li>
        <li>Which public keys are in the bait pool and when they expire.</li>
      </ul>
      <p>
        What it cannot see: the text of any message, who is really typing it,
        or any private key. If the server itself were fully compromised, an
        attacker would still only obtain ciphertext and public keys — useless
        without the private keys that never left your devices.
      </p>

      <h3>Glossary</h3>
      <ul>
        <li><strong>Bait / key</strong> — a public key you deposit to receive messages.</li>
        <li><strong>Cast</strong> — sending a message into the pool.</li>
        <li><strong>Catch</strong> — a message that arrived for your bait.</li>
        <li><strong>Bottle</strong> — one encrypted message plus its wrapped keys.</li>
        <li><strong>Secret key</strong> — your encrypted export of private keys.</li>
        <li><strong>Relay / server</strong> — the blind courier that stores ciphertext.</li>
      </ul>
    </>
  );
}

export function PrivacyContent() {
  return (
    <>
      <h2>Privacy Policy</h2>
      <p>
        a09f is designed so the server is <strong>blind</strong>: it stores
        ciphertext and public keys, never plaintext or private keys.
      </p>

      <h3>What stays on your device</h3>
      <ul>
        <li>Message plaintext — encrypted before it leaves your device.</li>
        <li>Private keys (identity, pool, reply) — stored in on-device storage
          (IndexedDB). They are never transmitted.</li>
        <li>Your secret key export — an encrypted backup you choose to create.</li>
      </ul>

      <h3>What the server sees</h3>
      <ul>
        <li><strong>Ciphertext and wrapped keys</strong> — unreadable without
          the recipient's private key.</li>
        <li><strong>Public keys</strong> you deposit into the pool, plus an
          optional self-declared UTC offset used to prefer nearby timezones.</li>
        <li><strong>Metadata</strong>: timestamps, message/thread structure
          (who replied to what — as opaque IDs), sizes, delivery/claim state.</li>
        <li><strong>IP address</strong>, used transiently for rate limiting and
          abuse prevention. We do not build advertising profiles from it.</li>
      </ul>
      <p>
        Because bottle structure is public metadata, an observer can see that a
        conversation exists and its shape — but not what it says.
      </p>

      <h3>Your IP address</h3>
      <p>
        Your IP address <strong>is still recorded by the server</strong> — it is
        used transiently for rate limiting and abuse prevention, and may appear
        in standard server logs. a09f cannot hide your IP from the relay
        operator; only you can.
      </p>
      <p>
        If you want to be untracked, browse through an anonymity tool:
      </p>
      <ul>
        <li>
          <a href="https://www.torproject.org/" target="_blank" rel="noopener noreferrer">
            Tor Browser
          </a>{" "}
          — free, routes traffic through three relays so the server only sees a
          Tor exit node.
        </li>
        <li>
          A reputable VPN or proxy also masks your IP, though it shifts trust
          to the VPN provider.
        </li>
      </ul>
      <p>
        Note: Tor does not make you unidentifiable inside the app — your keys,
        messages and timing patterns are still yours. It only hides your IP
        from the server.
      </p>

      <h3>Compromised keys</h3>
      <p>
        Your private keys are the only thing that can decrypt messages sent
        to you. If a key is stolen — through malware, a shared device, a
        leaked secret key export, or any other means — the holder can read every
        message ever addressed to that key, including messages from long
        ago. This is inherent to how end-to-end encryption works: the
        server never sees your keys, so it also cannot tell whether access
        came from you or an impostor.
      </p>
      <p>
        Guard your keys accordingly: never share a secret key export, keep your
        secret key passphrase separate from the file itself, and revoke devices
        you no longer control (Settings → devices). If you believe a key is
        compromised, stop using it and generate a fresh identity — there is
        no way to "rotate" a leaked key retroactively.
      </p>

      <h3>Payments (Polar.sh)</h3>
      <p>
        If you subscribe, checkout and billing are handled entirely by
        Polar.sh, our merchant of record. Polar receives and stores your
        payment details, email, and billing information — we do not. The
        only data we exchange with Polar is your anonymous identity id and
        subscription status. We never receive, store, or process personal
        data for payments.
      </p>
      <p>
        Because our records link a subscription to an anonymous identity
        id only, your payment history cannot be connected to your messages
        or identity key by us.
      </p>

      <h3>Accounts & identity</h3>
      <p>
        Registration is optional. A username only enables block/report
        features; it is not linked to your keys or messages cryptographically.
      </p>

      <h3>Reports & blocks</h3>
      <p>
        Reports store the reported bottle ID, optional reason, and — if you are
        signed in — your user ID for moderation. Blocks prevent your keys from
        being selected as recipients for that user's casts.
      </p>

      <h3>Data retention</h3>
      <ul>
        <li>Pool keys expire after their TTL and are removed automatically.</li>
        <li>Active bottles expire; delivered bottles are archived encrypted.</li>
        <li>We do not sell or share your data with third parties.</li>
      </ul>

      <h3>Your controls</h3>
      <p>
        Export your secret key to back up keys, delete app data to wipe everything
        locally, and use a different device identity at any time — there is no
        central account tying your activity together.
      </p>
    </>
  );
}
