const SQLite = require("better-sqlite3");
const WebSocket = require("ws");
const { relays } = require("../config");
const socks = new Set();
const sess = new SQLite(process.env.IN_MEMORY ? null : (__dirname + "/../.temporary.db"));
const csess = new Map();

// Handle database....
sess.unsafeMode(true);

// Temporary database.
sess.exec("CREATE TABLE IF NOT EXISTS sess (cID TEXT, subID TEXT, filter TEXT);");
sess.exec("CREATE TABLE IF NOT EXISTS events (cID TEXT, subID TEXT, eID TEXT);"); // To prevent transmitting duplicates

// CL - User socket
module.exports = (ws, req) => {
  ws.id = process.pid + Math.floor(Math.random() * 1000) + "_" + csess.size;

  console.log(process.pid, `->- ${req.headers["x-forwarded-for"]?.split(",")[0] || req.socket.address()?.address} is now known as ${ws.id}`);
  ws.on("message", data => {
    try {
      data = JSON.parse(data);
    } catch {
      return ws.send(
        JSON.stringify(["NOTICE", "error: bad JSON."])
      )
    }

    switch (data[0]) {
      case "EVENT":
        if (!data[1]?.id) return ws.send(JSON.stringify(["NOTICE", "error: no event id."]));
        bc(data, ws.id);
        ws.send(JSON.stringify(["OK", data[1]?.id, true, ""]));
        break;
      case "REQ":
        if (data.length < 3) return ws.send(JSON.stringify(["NOTICE", "error: bad request."]));
        if (typeof(data[2]) !== "object") return ws.send(JSON.stringify(["NOTICE", "expected filter to be obj, instead gives the otherwise."]));
        // eventname -> 1_eventname
        bc(data, ws.id);
        sess.prepare("INSERT INTO sess VALUES (?, ?, ?);").run(ws.id, data[1], JSON.stringify(data[2]));
        ws.send(JSON.stringify(["EOSE", data[1]]));
        break;
      case "CLOSE":
        if (typeof(data[1]) !== "string") ws.send(JSON.stringify(["NOTICE", "error: bad request."]));
        bc(data, ws.id);
        sess.prepare("DELETE FROM sess WHERE cID = ? AND subID = ?;").run(ws.id, data[1]);
        sess.prepare("DELETE FROM events WHERE cID = ? AND subID = ?;").run(ws.id, data[1]);
        break;
      default:
        console.warn(process.pid, "---", "Unknown command:", data.join(" "));
        ws.send(JSON.stringify(["NOTICE", "error: unrecognized command."]));
        break;
    }
  });

  ws.on('error', console.error);
  ws.on('close', _ => {
    console.log(process.pid, "---", "Sock", ws.id, "has disconnected.");
    csess.delete(ws.id);
    for (i of sess.prepare("SELECT subID FROM sess WHERE cID = ?").iterate(ws.id)) {
      bc(["CLOSE", i.subID]);
    }

    sess.prepare("DELETE FROM sess WHERE cID = ?;").run(ws.id);
    sess.prepare("DELETE FROM events WHERE cID = ?;").run(ws.id);
    terminate_sess(ws.id);
  });

  csess.set(ws.id, ws);
  relays.forEach(_ => newConn(_, ws.id));
}

// CL - Broadcast message to every existing client sockets
function bc_c(msg, id) {
  for (sock of csess) {
    if (sock.id !== id) continue;
    if (sock.readyState >= 2) return csess.delete(sock.id);
    sock.send(JSON.stringify(msg));
  }
}

// WS - Broadcast message to every existing sockets
function bc(msg, id) {
  for (sock of socks) {
    if (sock.id !== id) continue;
    if (sock.readyState >= 2) return socks.delete(sock);
    sock.send(JSON.stringify(msg));
  }
}

// WS - Terminate all existing sockets that were for <id>
function terminate_sess(id) {
  for (sock of socks) {
    if (sock.id !== id) continue;
    sock.terminate();
    socks.delete(sock);
  }
}

// WS - Sessions
function newConn(addr, id) {
  if (!csess.has(id)) return;
  const relay = new WebSocket(addr);

  relay.id = id;
  relay.addr = addr;
  relay.on('open', _ => {
    socks.add(relay); // Add this socket session to [socks]
    console.log(process.pid, "---", `[${id}] [${socks.size}/${relays.length}]`, relay.addr, "is connected");
    for (i of sess.prepare("SELECT subID, filter FROM sess WHERE cID = ?;").iterate(id)) {
      if (relay.readyState >= 2) break;
      relay.send(JSON.stringify(["REQ", i.subID, JSON.parse(i.filter)]));
    }
  });

  relay.on('message', data => {
    try {
      data = JSON.parse(data);
    } catch (error) {
      return console.error(error);
    }

    switch (data[0]) {
      case "EVENT": {
        if (data.length < 3 || typeof(data[1]) !== "string" || typeof(data[2]) !== "object") return;
        if (sess.prepare("SELECT * FROM events WHERE cID = ? AND subID = ? AND eID = ?;").get(id, data[1], data[2]?.id)) return; // No need to transmit once it has been transmitted before.

        sess.prepare("INSERT INTO events VALUES (?, ?, ?);").run(id, data[1], data[2]?.id);
        bc_c(data, id);
        break;
      }
    }
  });

  relay.on('error', _ => console.error(process.pid, "-!-", relay.addr, _.toString()));
  relay.on('close', _ => {
    socks.delete(relay) // Remove this socket session from [socks] list
    console.log(process.pid, "-!-", `[${socks.size}/${relays.length*csess.size}]`, "Disconnected from", relay.addr);

    if (!csess.has(id)) return;
    setTimeout(_ => newConn(addr, id), 5000); // As a bouncer server, We need to reconnect.
  });
}