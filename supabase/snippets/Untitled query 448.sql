alter table roster_athletes add column roster_url text;
  create index roster_athletes_roster_url_idx on roster_athletes(roster_url);