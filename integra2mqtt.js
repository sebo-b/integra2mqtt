
const integraIP='XX.XX.XX.XX';
const integraPort=7094;
const maxZones = 64;

const mqttURL="mqtt://USER:PASSS@HOST:PORT";
const mqttTopic="integra";

const hassDiscoveryTopic = "homeassistant";
//const hassDiscoveryTopic = "hass/discovery";

/////////// END OF CONFIG

import { strict as assert } from 'assert';
import { Socket } from "net";
import mqtt from "mqtt";
import { setInterval as setIntervalAsync } from 'node:timers/promises';

import * as IntegraMessages from "satel-integra-integration-protocol/messages.js";
import IntegraDecoder from "satel-integra-integration-protocol/decoder.js";
const Integra = {
    ...IntegraMessages,
    Decoder: IntegraDecoder
};

/////////// end of imports

let readZoneNames = 0;

function logHex(data,header='') {

    const lineLen = 16;

    let i = 0;
    let strH = '';
    let strA = '';

    header = header.padEnd(8,' ').slice(0,8);

    let p = () => {
        if (i) {
            console.log(
                header.padEnd(8,' ').slice(0,8)
                + ' : '
                + strH.padEnd(lineLen*3,' ')
                + ' '
                + strA);
            strH = '';
            strA = '';
            i = 0;
            header = ''.padStart(8,' ');
        }
    };

    for (let b of data) {
        strH += b.toString(16).toUpperCase().padStart(2,'0') + ' ';
        strA += b>32? String.fromCharCode(b): '.';

        if (++i == lineLen) {
            p();
        }
    }
    p();
}

/////////// MQTT

const commandTopic = `${mqttTopic}/cmd`;
const zoneTopic = `${mqttTopic}/zone`;

let mqttClient = mqtt.connect(mqttURL);
mqttClient.subscribe(commandTopic);

mqttClient.on("message", (topic, message) => {
    if (topic == commandTopic) {
        switch (message.toString()) {
            case "refreshZoneNames":
                readZoneNames = 0;
                break;
        }
    }
});

/////////// SATEL

let sock = new Socket();
let zones = [...Array(maxZones)].map( () => ({name:'',state:undefined}));
let fullFrameReceived = () => {};

async function homeAssistantDiscovery() {
    if (!hassDiscoveryTopic)
        return Promise.resolve;
    
    console.log("starting HA discovery");
    for (let i = 0; i < maxZones; ++i) {
        let zoneNumStr = (i+1).toString().padStart(3,'0');
        let zoneId = `integra_zone_${zoneNumStr}`;
        await mqttClient.publishAsync(`${hassDiscoveryTopic}/binary_sensor/integra/${zoneId}/config`, 
            JSON.stringify({
                name: zones[i].name || `Zone ${zoneNumStr}`,
                device_class: "motion",
                state_topic: `${zoneTopic}/${zoneNumStr}`,
                default_entity_id: `binary_sensor.${zoneId}`,
                value_template: "{{ value_json.state }}",
                unique_id: zoneId,
                device:{
                    name:"Integra",
                    identifiers: "integra_1F36E156-59DF-4737-9036-C14AD9951AE1",
                    manufacturer: "Satel"
                }                
           })
        );
    }
    console.log("HA discovery completed");
}

async function mainLoop() {
    
    console.log('Main loop started');
    
    let interval = setIntervalAsync(2500, Date.now());
    
    let zoneViolCmd = Integra.encodeZonesViolationCommand();
    while (true) {

        let frameReceived = new Promise( (r) => fullFrameReceived = r );

        if (readZoneNames < maxZones) {
            if (readZoneNames == 0)
                console.log("Zone names read started")

            sock.write(
                Integra.encodeReadDeviceName(Integra.DeviceType.Zone,++readZoneNames));


            if (readZoneNames < maxZones)
                process.stdout.write(".");
            else {
                console.log(". DONE");
                homeAssistantDiscovery();
            }
        }
        else  {
            sock.write(zoneViolCmd);
            await interval.next();
        }

        await frameReceived;
    }
}

function handleMessage(message) {

    if (message instanceof Integra.ReadDeviceNameAnswer) {
        zones[message.number-1].name = message.name;
    }
    else if (message instanceof Integra.ZonesViolationAnswer) {

        const flags = message.flags;
        assert(flags.length >= maxZones)
        for (let i = 0; i < maxZones; ++i) {
            if (zones[i].state != flags[i]) {
                zones[i].state = flags[i];
                //mqttClient.publishAsync(`${zoneTopic}/${(i+1).toString().padStart(3,'0')}`, 
                //    zones[i].state? "ON": "OFF");

                mqttClient.publishAsync(`${zoneTopic}/${(i+1).toString().padStart(3,'0')}`,
                    JSON.stringify({
                        zone_number: i+1,
                        name: zones[i].name,
                        state: zones[i].state? "ON": "OFF"
                    }),
                    {retain: true}
                );
            }
        }

        //console.clear();
        //let dots = flags.reduce( (a,v) =>  a + (v?"●": "·"),"").match(new RegExp(".{1,16}","g"));
        //for (let l of dots) {
        //    console.log(l);
        //}
        
    }
}

sock.on('connect', () => {
    console.log('Connected');
    mainLoop();
});

sock.on('close', () => {
	console.log('connection closed');
	process.exit(0);
});

sock.on("error", (e) => { 
    console.log(`error: ${e}`); 
    process.exit(1); 
});

let decoder = new Integra.Decoder();
sock.on('data', (data) => {

    for (let b of data) {
        if (decoder.addByte(b)) {
            fullFrameReceived();
            let message = Integra.decodeMessage(decoder);
            if (message)
                handleMessage(message);
        }
    }

});


sock.connect(integraPort, integraIP);

