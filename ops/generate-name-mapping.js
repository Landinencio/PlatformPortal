/**
 * Generates the SQL for the developer_name_map table
 * based on GitLab group members with problematic display names.
 * 
 * Run: node ops/generate-name-mapping.js
 */

// Derive a readable name from an email like "martin.godoy@ext.iskaypet.com" → "Martin Godoy"
function deriveNameFromEmail(email) {
  const local = email.split("@")[0];
  return local
    .split(".")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

// Derive a readable name from a username like "martin.godoy" → "Martin Godoy"
function deriveNameFromUsername(username) {
  return username
    .split(/[._-]/)
    .filter((p) => p.length > 0)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

// Members with problematic names from the GitLab audit
// Format: [gitlab_id, username, current_display_name, suggested_name]
const members = [
  [28155997, "adrian.dominguez2",       "adominguez@seidor.es",                    "Adrián Domínguez"],
  [28592960, "andres.bravo2",           "andres.bravo@iskaypet.com",               "Andrés Bravo"],
  [23424773, "antonio.trujillo1",       "antonio.trujillo@iskaypet.com",           "Antonio Trujillo"],
  [29999115, "borja.torres",            "borja.torres@iskaypet.com",               "Borja Torres"],
  [27705162, "group_66335040_bot_4b71a05dcf3e75e8844f4d422a284fe9", "cicd_token", null], // bot — skip
  [23139016, "daniel.romero5",          "daniel.romero@iskaypet.com",              "Daniel Romero"],
  [29447230, "daniel.rolon",            "dany.rolon",                              "Daniel Rolón"],
  [31208356, "david.alvarez8",          "david.alvarez@ext.iskaypet.com",          "David Álvarez"],
  [28391492, "ddiazs1",                 "ddiazs@seidor.es",                        "Diego Díaz"],
  [28577246, "diego.avila2",            "diego.avila@iskaypet.com",                "Diego Ávila"],
  [20801883, "elias.fustero",           "elias.fustero@iskaypet.com",              "Elías Fustero"],
  [30815799, "ezequiel.ponze",          "ezequiel.ponze@ext.iskaypet.com",         "Ezequiel Ponce"],
  [28156000, "fernando.ramirez1",       "framirez@seidor.es",                      "Fernando Ramírez"],
  [28690762, "francisco.luque",         "francisco.luque@iskaypet.com",            "Francisco Luque"],
  [32613178, "gonzalo.aguila",          "gonzalo.aguila@ext.iskaypet.com",         "Gonzalo Águila"],
  [28534214, "hector.garcia4",          "hector.garcia@iskaypet.com",              "Héctor García"],
  [29130695, "ignacio.nayar",           "ignacio.nayar@iskaypet.com",              "Ignacio Nayar"],
  [31227559, "javier.delpozo1",         "javier.delpozo@ext.iskaypet.com",         "Javier del Pozo"],
  [22241158, "jesus.mari",              "jesus.mari@iskaypet.com",                 "Jesús Marí"],
  [35774603, "jordi.salazar1",          "jordi.salazar@ext.iskaypet.com",          "Jordi Salazar"],
  [28922471, "jose.wong",               "jose.wong@ext.iskaypet.com",              "José Wong"],
  [28807335, "juan.estevez-alonso",     "juan.estevez-alonso@viseo.com",           "Juan Estévez-Alonso"],
  [35363564, "juan.moral",              "juan.moral@ext.iskaypet.com",             "Juan Moral"],
  [26020925, "laura.ros",               "laura.ros@iskaypet.com",                  "Laura Ros"],
  [30359706, "lluis.sanuy1",            "lluis.sanuy@iskaypet.com",                "Lluís Sanuy"],
  [29446555, "lucas.baccillere2",       "lucas.baccillere@ext.iskaypet.com",       "Lucas Baccillere"],
  [29599902, "luciano.sanchez1",        "luciano.sanchez@ext.iskaypet.com",        "Luciano Sánchez"],
  [28962957, "mario.brenaldez",         "mario.bernaldez@iskaypet.com",            "Mario Bernáldez"],
  [29340768, "martin.godoy",            "martin.godoy@ext.iskaypet.com",           "Martín Godoy"],
  [29382552, "miguel.barrientos2",      "miguel.barrientos@ext.iskaypet.com",      "Miguel Barrientos"],
  [31459033, "miguelangel.galindo",     "miguelangel.galindo@ext.iskaypet.com",    "Miguel Ángel Galindo"],
  [28508520, "monica.serrano",          "monica.serrano@iskaypet.com",             "Mónica Serrano"],
  [35116630, "pablo.lopezosa",          "pablo.lopezosa@ext.iskaypet.com",         "Pablo López-Osa"],
  [26968964, "renzo.daccorso-old",      "renzo.daccorso@intersoftware.global",     null], // old account — skip
  [29597159, "rodrigo.acevedo1",        "rodrigo.acevedo@ext.iskaypet.com",        "Rodrigo Acevedo"],
  [34900456, "Santy.prada",             "santy.prada@iskaypet.com",                "Santy Prada"],
  [33459831, "sara.reyes",              "sara.reyes@iskaypet.com",                 "Sara Reyes"],
  [28810876, "yair.oliva",              "yair.oliva@ext.iskaypet.com",             "Yair Oliva"],
];

console.log("-- Developer name mapping table");
console.log("-- Generated from GitLab group audit");
console.log("-- Review and adjust names before applying");
console.log("");
console.log("CREATE TABLE IF NOT EXISTS developer_name_map (");
console.log("  id SERIAL PRIMARY KEY,");
console.log("  gitlab_username TEXT NOT NULL UNIQUE,");
console.log("  gitlab_id INTEGER,");
console.log("  canonical_name TEXT NOT NULL,");
console.log("  notes TEXT,");
console.log("  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()");
console.log(");");
console.log("");
console.log("-- Insert/update mappings");
console.log("INSERT INTO developer_name_map (gitlab_username, gitlab_id, canonical_name, notes) VALUES");

const rows = members
  .filter(([, , , name]) => name !== null)
  .map(([id, username, displayName, suggestedName]) => {
    return `  ('${username}', ${id}, '${suggestedName}', 'was: ${displayName}')`;
  });

console.log(rows.join(",\n"));
console.log("ON CONFLICT (gitlab_username) DO UPDATE SET");
console.log("  canonical_name = EXCLUDED.canonical_name,");
console.log("  notes = EXCLUDED.notes;");
console.log("");
console.log("-- Total mappings: " + rows.length);
