
import secrets from "./secrets.js"

const integraIP = secrets.integraIP;
const integraPort=7094;
const maxZones = 54;

const mqttURL = secrets.mqttURL;
const mqttTopic="integra";

const hassDiscoveryTopic = "homeassistant";
const hassStatusTopic = "homeassistant/status";
//const hassDiscoveryTopic = "hass/discovery";
//const hassStatusTopic = "hass/status";

/////////// END OF CONFIG

import { strict as assert } from 'assert';
import { Socket } from "net";
import mqtt from "mqtt";
import { setInterval as setIntervalAsync, setTimeout as setTimeoutAsync } from 'node:timers/promises';

import * as IntegraMessages from "satel-integra-integration-protocol/messages.js";
import IntegraDecoder from "satel-integra-integration-protocol/decoder.js";
const Integra = {
    ...IntegraMessages,
    Decoder: IntegraDecoder
};
/////////// end of imports
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

const Messages = Object.freeze({
    RefreshNames: 1,
    RunHADiscovery: 2,
    ReadZoneStates: 3,
});
const messages = [
    Messages.RefreshNames,
    Messages.RunHADiscovery
];
let newMessageArrived = () => {};

/////////// MQTT

const commandTopic = `${mqttTopic}/cmd`;
const zoneTopic = `${mqttTopic}/zone`;

let mqttClient = mqtt.connect(mqttURL);
mqttClient.subscribe(commandTopic);
mqttClient.subscribe(hassStatusTopic);

mqttClient.on("message", (topic, message) => {
    if (topic == commandTopic) {
        switch (message.toString().toLowerCase()) {
            case "refresh_names":
                messages.push(Messages.RefreshNames);
                newMessageArrived();
                break;
            case "run_ha_discovery":
                messages.push(Messages.RunHADiscovery);
                newMessageArrived();
                break;
            case "read_zone_states":
                messages.push(Messages.ReadZoneStates);
                newMessageArrived();
                break;
        }
    }
    else if (topic == hassStatusTopic && message.toString().toLowerCase() == "online") {
	    messages.push(Messages.RunHADiscovery);
	    newMessageArrived();
    }
});

/////////// SATEL

class IntegraCommand {

    #integraIP
    #integraPort

    async #connect(fullFramePF) {

        let sock = new Socket();

        return new Promise( (res,rej) => {

            sock.connect(this.#integraPort, this.#integraIP, () => res(sock) );
            sock.once('error', (e) => rej(e) );

            let decoder = new Integra.Decoder();
            sock.on('data', (data) => {
                for (let b of data) {
                    if (decoder.addByte(b)) {
                        let message = Integra.decodeMessage(decoder);
                        if (message)
                            fullFramePF.resolve(message);
                        else
                            fullFramePF.reject(new Error("decodeMessage returned null"));
                    }
                }
            });
        });
    }

    constructor(integraIP, integraPort) {
        this.#integraIP = integraIP;
        this.#integraPort = integraPort;
    }

    async refreshNames(zones) {

        let fullFramePF = {
            resolve:  (message) => {},
            reject: (err) => {}
        };
        let sock = await this.#connect(fullFramePF);
        
        for (let z = 1; z <= zones.length; ++z) {

            let fullFrameP = new Promise( (res,rej) => { fullFramePF.resolve = res; fullFramePF.reject = rej; });
            let d = Integra.encodeReadDeviceName(Integra.DeviceType.Zone,z);
            sock.write(d);

            let message = await fullFrameP;
            if (message instanceof Integra.ReadDeviceNameAnswer) {
                assert(z == message.number);
                zones[message.number-1].name = message.name;
                process.stdout.write(".");
            } 
            else if (message instanceof Integra.CommandResultAnswer) {
                console.log(`zone=${z} result=${message.resultMessage}`);
            }
            else {
                console.log(`zone=${z} message=${message}`);
            }
        }
        sock.resetAndDestroy();
        console.log(" DONE");

    }

    async readZoneStates(zones) {

        let fullFramePF = {
            resolve:  (message) => {},
            reject: (err) => {}
        };

        let sock = await this.#connect(fullFramePF);
        let fullFrameP = new Promise( (res,rej) => { fullFramePF.resolve = res; fullFramePF.reject = rej; });
        sock.write(Integra.encodeZonesViolationCommand());
        let message = await fullFrameP;
        //process.stdout.write("+");

        const flags = message.flags;
        assert(flags.length >= zones.length);

        let updatedZones = [];
        for (let i = 0; i < zones.length; ++i) {
            if (zones[i].state != flags[i]) {
                zones[i].state = flags[i];
                updatedZones.push(zones[i]);
                //console.log(`Zone ${(i+1).toString().padStart(3,'0')}: ${flags[i]}`);
            }
        }

        //console.clear();
        //let dots = flags.reduce( (a,v) =>  a + (v?"●": "·"),"").match(new RegExp(".{1,16}","g"));
        //for (let l of dots) {
        //    console.log(l);
        //}

        sock.resetAndDestroy();

        return updatedZones;
    }
}

async function _homeAssistantDiscovery(zones) {

    if (!hassDiscoveryTopic)
        return;

    console.log("starting HA discovery");
    for (let z of zones) {
        
        let zoneNumStr = z.zone_number.toString().padStart(3,'0');
        let zoneId = `integra_zone_${zoneNumStr}`;

        await mqttClient.publishAsync(`${hassDiscoveryTopic}/binary_sensor/integra/${zoneId}/config`, 
            JSON.stringify({
                name: z.name || `Zone ${zoneNumStr}`,
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

async function _publishZoneState(zones) {
    for (let z of zones) {
        mqttClient.publishAsync(`${zoneTopic}/${(z.zone_number).toString().padStart(3,'0')}`,
            JSON.stringify({
                zone_number: z.zone_number,
                name: z.name,
                state: z.state? "ON": "OFF"
            }),
            {retain: true}
        );
    }
}


async function main() {
    
    console.log('Main loop started');
    let zones = [...Array(maxZones)].map( (e,i) => ({zone_number: i+1, name:'',state:undefined}));
    
    while (true) {

        let cmd = messages.shift();
                
        switch (cmd) {

            case Messages.RefreshNames:
                let icRN = new IntegraCommand(integraIP,integraPort);
                await icRN.refreshNames(zones);
                continue;

            case Messages.RunHADiscovery:
                _homeAssistantDiscovery(zones);
                continue;

            default:
                await Promise.any([
                    new Promise( (r) => newMessageArrived = r ),
                    setTimeoutAsync(1000,0)
                ]);

            case Messages.ReadZoneStates:
                let icRZ = new IntegraCommand(integraIP,integraPort);
                let updatedZones = await icRZ.readZoneStates(zones);
                await _publishZoneState(updatedZones);
        }
    }
}

main();
