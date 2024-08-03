const net = require('net');
const fs = require('fs');
const path = require('path');

const TCP_HOST = '127.0.0.1';
const TCP_PORT = 3000; //change port if the TCP server is port is changed

const PACKET_SIZE = 17; // 4 bytes for Symbol + 1 byte for Buy/Sell Indicator + 4 bytes for Quantity + 4 bytes for Price + 4 bytes for Packet Sequence
const receivedPackets = new Set(); 
const packetData = []; 
let maxSequence = 0; // To keep track of the maximum sequence number received

const retryDelay = 1000; // Delay before retrying a connection in ms

const connectToServer = () => {
  return new Promise((resolve, reject) => {
    const client = new net.Socket();

    const onError = (err) => {
      console.error('Client error:', err.message);
      client.destroy();
      reject(err);
    };

    const onClose = () => {
      console.log('Connection closed');
    };

    client.on('error', onError);
    client.on('close', onClose);

    client.connect(TCP_PORT, TCP_HOST, () => {
      console.log('Connected to server');
      client.removeListener('error', onError);
      client.removeListener('close', onClose);
      resolve(client);
    });
  });
};

const sendRequest = (client, callType, resendSeq = 0) => {
  return new Promise((resolve, reject) => {
    const payload = Buffer.alloc(2);

    payload.writeUInt8(callType, 0);
    payload.writeUInt8(resendSeq, 1);

    client.write(payload);

    client.on('data', (data) => {
      let offset = 0;
      while (offset < data.length) {
        const packet = data.slice(offset, offset + PACKET_SIZE);
        parsePacket(packet);
        offset += PACKET_SIZE;
      }

      if (callType === 1) {
        client.end(); // Close the connection after receiving data for callType 1
      }
    });

    client.on('close', () => {
      console.log('Connection closed');
      resolve();
    });

    client.on('error', (err) => {
      console.error('Client error:', err.message);
      client.destroy();
      reject(err);
    });

    if (callType === 2) {
      client.on('data', () => {
        client.destroy(); //ending connection so that we can resend request for the next missing packet
      });
    }
  });
};

const parsePacket = (packet) => {
  if (packet.length !== PACKET_SIZE) {
    console.error('Invalid packet size');
    return;
  }

  const symbol = packet.toString('ascii', 0, 4);
  const buySellIndicator = packet.toString('ascii', 4, 5);
  const quantity = packet.readUInt32BE(5);
  const price = packet.readUInt32BE(9);
  const packetSequence = packet.readUInt32BE(13);

  if (!symbol || !buySellIndicator || isNaN(quantity) || isNaN(price) || isNaN(packetSequence)) {
    console.error('Invalid packet data');
    return;
  }

  const packetDetails = {
    symbol,
    buySellIndicator,
    quantity,
    price,
    packetSequence,
  };

  receivedPackets.add(packetSequence);
  packetData.push(packetDetails);

  if (packetSequence > maxSequence) {
    maxSequence = packetSequence;
  }

  console.log(`Parsed Packet:
    Symbol: ${symbol}
    Buy/Sell Indicator: ${buySellIndicator}
    Quantity: ${quantity}
    Price: ${price}
    Packet Sequence: ${packetSequence}
  `);
};

const requestMissingPackets = async () => {
  for (let i = 1; i <= maxSequence; i++) {
    if (!receivedPackets.has(i)) {
      console.log(`Requesting missing packet: ${i}`);
      try {
        const client = await connectToServer();
        await sendRequest(client, 2, i); // Wait for each resend request to complete before proceeding
      } catch (err) {
        console.error(`Failed to request missing packet ${i}, retrying in ${retryDelay} ms...`);
        await new Promise((resolve) => setTimeout(resolve, retryDelay));
        i--; // Retry the current sequence number
      }
    }
  }
};

const savePacketsToJson = () => {
  const filePath = path.join(__dirname, 'orders.json');
  fs.writeFileSync(filePath, JSON.stringify(packetData, null, 2), 'utf-8');
  console.log(`Packet data saved to ${filePath}`);
};

const main = async () => {
  try {
    const client = await connectToServer();
    await sendRequest(client, 1);

    await requestMissingPackets();

    console.log('All packets received:');

    // Save packets to JSON file
    savePacketsToJson();
  } catch (err) {
    console.error('Failed to connect to server:', err.message);
  }
};

main().catch((err) => console.error(err));
